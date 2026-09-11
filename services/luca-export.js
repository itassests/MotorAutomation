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
    // A 3-wheeler goods carrier (GCV3W / goods auto) is NOT a 4-wheel truck — keep it
    // distinct so it doesn't collapse onto a truck of the same tonnage (USER 2026-08,
    // Bajaj: "GCV3W" vs "GCV4W 1.8-2.5T"). 3W is excluded from the GCV/Consolidated cuts.
    if (/GCV\s*3\s*W|\b3\s*W\b|3\s*WHEEL|THREE\s*WHEEL/.test(hay)) return 'gcv_3w';
    // USER 2026-09: do NOT split 4-wheel goods into lcv/hcv — all goods carriers are
    // one 'gcv' product. The weight-band lcv/hcv split dropped Royal's entire goods
    // TP from the GCV/Consolidated cut (which excluded lcv+hcv); folding them into
    // gcv keeps every insurer's goods present under a single product.
    return 'gcv';
  }
  if (V === 'MISC' || V === 'MIS') {
    if (/AUTO|E-?RICK|RICKSHAW|\b3\s*W/.test(hay)) return 'auto';
    return 'misc';   // Ambulance / MISC-D / Motor Trade / CPA etc. are Misc, NOT gcv
  }
  return V.toLowerCase();
}

// Map our internal insurer slug → the CANONICAL Luca insurer id (the exact slug
// set the Luca importer expects — hyphenated, full names for multi-word insurers:
// go-digit, new-india, united-india, royal-sundaram, cholamandalam). USER
// 2026-09-01 supplied the canonical list; earlier truncation (chola/go_digit/royal)
// was the "insurer name format changed" mismatch. Returns null for insurers with
// NO Luca slug (kiwi, kshema) — the caller drops those rows.
const LUCA_INSURER = {
  bajaj_allianz: 'bajaj', bharti_axa: 'bharti', chola_ms: 'cholamandalam',
  future_generali: 'future', go_digit: 'go-digit', hdfc_ergo: 'hdfc',
  icici_lombard: 'icici', iffco_tokio: 'iffco', indusind: 'indusind',
  kotak: 'kotak', liberty_videocon: 'liberty', magma: 'magma', magma_hdi: 'magma',
  national_insurance: 'national', new_india_assurance: 'new-india',
  oriental_insurance: 'oriental', raheja_qbe: 'raheja', reliance: 'indusind',
  royal_sundaram: 'royal-sundaram', sbi_general: 'sbi', shriram: 'shriram',
  tata_aig: 'tata', united_india_insurance: 'united-india',
  universal_sompo: 'universal', zuno: 'zuno',
  // No canonical Luca slug — exclude from the export (USER 2026-09-01).
  kiwi: null, kshema: null,
};
function lucaInsurer(slug) {
  const s = String(slug || '').toLowerCase().trim().replace(/\s+/g, '_');
  if (Object.prototype.hasOwnProperty.call(LUCA_INSURER, s)) return LUCA_INSURER[s];
  // Unknown internal slug: fall back to first token (keeps the file from silently
  // dropping a newly-added insurer), but this shouldn't happen for known grids.
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
  // LUCA NumericRange END IS INCLUSIVE (USER 2026-09 confirmed): a band [lo,hi]
  // covers hi, and consecutive bands are [a,b]/[b+1,c] with NO shared boundary.
  // So an inclusive source max M is emitted as-is (M), not M+1. (opts.exclusiveEnd
  // is retained for callers that still want the old half-open behaviour, but the
  // motor bands — age/seating/cc/gvw — all pass inclusive maxes now.)
  if (hi != null && o.exclusiveEnd) hi = hi + 1;
  if (hi != null && o.noMax != null && hi >= o.noMax) hi = null;
  if (lo == null && hi == null) return '';        // unbounded both ways = all
  const sc = (v) => +(v * (o.scale || 1)).toFixed(0);
  return `[${lo == null ? minDefault : sc(lo)},${hi == null ? 'null' : sc(hi)}]`;
}
const ccBand   = (mn, mx) => rangeArr(mn, mx, { minDefault: 1, noMax: 99999 });
const ageBand  = (mn, mx) => rangeArr(mn, mx, { minDefault: 0, noMax: 99 });   // inclusive end (USER 2026-09)
const seatBand = (mn, mx) => rangeArr(mn, mx, { minDefault: 1 });              // inclusive end (USER 2026-09)
// GVW: stored in TONNES, Luca wants KG (2.5T -> 2500). 999T = "no upper bound".
const gvwBand  = (mn, mx) => {
  // Mis-ingest guard (USER 2026-09, LUCA #2): iffco "GVW GT 40000 kg" rows stored
  // weight_band [4,0] — a stray comma split 40,000 into min=4 / max=0, giving the
  // empty band [4000,0]. The intent is GVW > 40000 kg → [40000, null].
  if (Number(mn) === 4 && Number(mx) === 0) return '[40000,null]';
  if (Number(mx) === 0 && Number(mn) > 0) mx = null;   // any ">X" band with max=0 → open-ended
  return rangeArr(mn, mx, { minDefault: 1, noMax: 999, scale: 1000 });
};

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
_addState('jammu_and_kashmir', 'jammu and kashmir', 'jammu & kashmir', 'j&k', 'jk', 'jandk', 'j and k', 'jammu kashmir', 'jammu', 'kashmir', 'srinagar', 'ladakh', 'la');
_addState('himachal_pradesh', 'himachal pradesh', 'himachal', 'hp');
_addState('punjab', 'punjab', 'pb');
_addState('uttarakhand', 'uttarakhand', 'uttaranchal', 'uk', 'ua');
_addState('uttar_pradesh', 'uttar pradesh', 'up', 'lucknow', 'kanpur', 'noida');
_addState('haryana', 'haryana', 'hr', 'gurgaon', 'gurugram', 'faridabad');
_addState('delhi', 'delhi', 'new delhi', 'dl', 'delhi ncr', 'ncr');
_addState('chandigarh', 'chandigarh', 'ch');
_addState('bihar', 'bihar', 'br', 'patna');
_addState('odisha', 'odisha', 'orissa', 'od', 'or', 'bhubaneshwar', 'bhubaneswar', 'bhubuneshwar', 'bhubneshwar', 'cuttack');
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
_addState('gujarat', 'gujarat', 'gujrat', 'gj', 'ahmedabad', 'surat', 'vadodara');
_addState('goa', 'goa', 'ga');
_addState('maharashtra', 'maharashtra', 'mh', 'mumbai', 'pune', 'nagpur', 'nashik', 'thane', 'aurangabad',
  'rom', 'romg', 'rom1', 'rom2', 'rom3', 'rom4');   // go-digit "Rest Of Maharashtra" clusters
_addState('daman_and_diu', 'daman and diu', 'daman & diu', 'daman', 'diu', 'dd');
_addState('dadra_and_nagar_haveli', 'dadra and nagar haveli', 'dadra & nagar haveli', 'dadra', 'dnh', 'dn', 'silvassa');
_addState('andhra_pradesh', 'andhra pradesh', 'andra pradesh', 'ap', 'andhra', 'vijayawada', 'vijaywada', 'visakhapatnam', 'vizag');
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
  // Cluster-coded fallback: go-digit / chola / sbi label regions as a state code
  // or city plus a quality tier — "GJ_Bad", "MH_Good", "Bad UP", "TN_Chennai",
  // "RJ_Jaipur", "MH_Mumbai". Strip filler/quality tokens and resolve ONLY when
  // exactly one state is unambiguous; multi-state clusters ("AP TS", "PB_CH") and
  // "all except …" negations stay blank rather than guess.
  if (!/EXCEPT|EXCLUD/.test(s)) {
    const toks = s.split(/[^A-Z0-9]+/).filter(Boolean)
      .filter((t) => !_STATE_FILLER.has(t) && !/^\d+$/.test(t) && !/^(GOOD|BAD)\d+$/.test(t));
    const found = new Set();
    for (const t of toks) { const sl = STATE_MAP[_sk(t)]; if (sl) found.add(sl); }
    if (found.size === 1) return [...found][0];
  }
  return null;
}
// Quality-tier / grouping words that decorate a cluster label but carry no state.
const _STATE_FILLER = new Set(['BAD', 'GOOD', 'REF', 'OPEN', 'DECLINED', 'DECLINE',
  'CLUSTER', 'GROUP', 'REST', 'OF', 'ALL', 'KEY', 'CITIES', 'CITY', 'ZONE', 'ZONES',
  'REGION', 'OTHERS', 'OTHER', 'NEW', 'OLD', 'TIER', 'GRADE', 'A', 'B', 'C', 'D']);

/** Canonical Luca state slug from a rule's state/region/sub_type (prefers state).
 * sub_type is a last-resort source: some grids (SBI Pvt-Car SATP) put the STATE
 * in sub_type ("West Bengal") while region is a cluster code ("WB - K"). It only
 * resolves when sub_type actually IS a state name — a segment/RTO-list sub_type
 * returns null and is ignored. */
function lucaState(state, region, subType) {
  return resolveStateSlug(state) || resolveStateSlug(region) || resolveStateSlug(subType) || '';
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

// LUCA matches `city` against the RTO's ACTUAL city — it has no grouped-region
// concept, so cluster labels ("roe", "rom1-4", "pb1/2", "up1-3", "rj1-5", "ka1/2",
// "mp1-3") and bare STATE names ("delhi", "haryana", "telengana") never match and
// leave the row dead (USER 2026-09, LUCA import). Drop those tokens from the
// comma-joined city list; keep real cities (Mumbai/Pune/… are not bare states).
const _CITY_CLUSTER = /^(ro[a-z]|rom)\d*$/i;               // ROE / ROM / ROM1-4 / ROW…
const _CITY_STATE_EXTRA = new Set(['TELENGANA', 'JAMMU', 'KASHMIR', 'LADAKH', 'NCR',
  'ALLGEOS', 'ALLGEO', 'DELHINCR', 'ALLINDIA', 'PANINDIA',
  // USER 2026-09 city report: region grouping codes (not supported → blank),
  // "bh" (Bihar, a state code not a city), and state names mis-parked in city.
  'BH', 'EAST', 'ROMAHARASHTRA', 'EASTUP', 'NORTHEAST', 'ROKARNATAKA', 'UTTARANCHALKS',
  'KERELA', 'ANDRAPRADESH',
  // USER 2026-09 city report: "gujrat" = misspelled state Gujarat parked in the
  // city column → drop from city; STATE_MAP maps it to gujarat for included_states.
  'GUJRAT',
  // USER 2026-09 city report #2: go-digit region/cluster codes that leaked into the
  // city column (not real cities, "region codes — not supported") → drop. good_*/bad_*
  // prefixed cluster labels are dropped by a rule in cleanCity below.
  'GJSAURASHTRA', 'ROMG', 'ROTN', 'CENTRAL',
  // Districts with NO LUCA-master city equivalent — the row's included_rto carries
  // the location, so drop the unrecognised city (USER: "use included_rto").
  'SHEIKHPURA', 'SOUTHDINAJPUR']);
// Spelling corrections → LUCA's master city name (USER 2026-09, LUCA import).
// Keyed on the _sk (upper, alnum-only) form so "Vishakapatnam"/"vishakapattnam"
// both hit. Value is the canonical spelling LUCA accepts.
const _CITY_SPELL = {
  VIJAYWADA: 'Vijayawada', VISHAKAPATNAM: 'Visakhapatnam', VISHAKAPATTNAM: 'Visakhapatnam',
  VISHAKHAPATNAM: 'Visakhapatnam', BHUBANESHWAR: 'Bhubaneswar', BHUBNESHWAR: 'Bhubaneswar',
  CUTTAK: 'Cuttack',
};
// A "city" value that is really a REGION PHRASE (not a place) — drop entirely.
const _CITY_REGION_PHRASE = /^(rest\s+of|entire|all\s+of|whole\s+of)\b|\bex(cl(uding)?)?\b|\bincluding\b|\bexcept\b|\bothers?\b/i;
// Grid "working" labels that leaked into the city column — drop.
const _CITY_WORKING = new Set(['BAD', 'GOOD', 'REF', 'OPEN', 'DECLINED', 'DECLINE',
  'CNG', 'DIESEL', 'PETROL', 'ELECTRIC', 'EV', 'COMP', 'SATP', 'SAOD', 'TP', 'OD', 'NCB',
  'SWIFTCNG', 'SWIFTDIESEL', 'PACKAGE', 'ALL', 'NEW', 'OLD']);
function cleanCity(s) {
  if (!s) return '';
  // Whole-value match FIRST so a compound UT name is not split on "&"
  // ("Dadra & Nagar Haveli" → one master city, not "Dadra" + "Nagar Haveli").
  const wholeKey = String(s).trim().toLowerCase().replace(/\s*&\s*/g, '_and_').replace(/\s+/g, '_');
  if (_CITY_ALIAS[wholeKey]) return _CITY_ALIAS[wholeKey];
  if (_CITY_MASTER_CI.has(wholeKey)) return _CITY_MASTER_CI.get(wholeKey);
  const out = []; const seen = new Set();
  // Split on comma / & / + / " and " — a value can pack TWO cities ("daman & diu").
  for (let tok of String(s).split(/\s*(?:,|&|\+|\band\b)\s*/i)) {
    // Strip a parenthetical state suffix: "aurangabad(bh)", "bilaspur(cgh)" → base;
    // and a trailing full stop ("dehradun." → "dehradun").
    let t = tok.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s{2,}/g, ' ').replace(/\.+\s*$/, '').trim();
    if (!t) continue;
    // "daman dui" / "daman diu" / "dd" packed as one token → the two cities Daman + Diu.
    if (/^DAMAN[_ ]?(DUI|DIU)$/i.test(t) || /^DD$/i.test(t)) {
      for (const c of ['Daman', 'Diu']) { const ck = _sk(c); if (!seen.has(ck)) { seen.add(ck); out.push(c); } }
      continue;
    }
    // go-digit quality-cluster labels ("Good_GJ_South", "Bad_Vizag_Vijayawada") are
    // region codes, not cities → drop (USER 2026-09 city report #2).
    if (/^(GOOD|BAD)[\s_]/i.test(t)) continue;
    if (_CITY_CLUSTER.test(t)) continue;                   // ROE / ROM1 …
    if (/^[A-Z]{2}\d+$/i.test(t)) continue;                // UP1 / KA2 / PB1 / MP3 / RJ4 …
    if (/^[A-Z]{2}\s*-\s*[A-Z0-9]+$/i.test(t)) continue;   // "UP - AKLGV" state-dash cluster code
    if (/_(GOOD|BAD|REF|OPEN|DECL)\d*$/i.test(t)) continue; // "APTS_Good" cluster-quality label
    if (_CITY_REGION_PHRASE.test(t)) continue;             // "rest of AP", "karnataka ex bangalore"
    const k = _sk(t);
    if (!k) continue;
    if (_BARE_STATE.has(k) || _CITY_STATE_EXTRA.has(k)) continue;   // bare state name
    if (_CITY_WORKING.has(k)) continue;                    // bad / good / swift cng …
    t = _CITY_SPELL[k] || t;                               // spelling correction → LUCA master
    t = canonCity(t);                                      // → LUCA master canonical (underscore/case/alias)
    const kk = _sk(t);
    if (t && !seen.has(kk)) { seen.add(kk); out.push(t); }
  }
  return out.join(', ');
}
// LUCA matches `city` against its master list, whose multi-word names use
// UNDERSCORES ("Tarn_Taran", "Udham_Singh_Nagar") and a fixed spelling. Map each
// token to the master's exact form: exact → underscored → case-insensitive →
// alias (config/luca_city_alias.json: Moradabad→Muradabad, districts→nearest
// master city). Unmatched real cities keep the underscored form (best effort —
// the master may carry a variant not in our copy). (USER 2026-09, LUCA city list.)
const _CITY_MASTER = (() => { try { return require('../config/luca_city_master.json') || []; } catch (_) { return []; } })();
const _CITY_ALIAS = (() => { try { return require('../config/luca_city_alias.json') || {}; } catch (_) { return {}; } })();
const _CITY_MASTER_SET = new Set(_CITY_MASTER);
const _CITY_MASTER_CI = new Map();                         // lower-underscored → canonical
for (const c of _CITY_MASTER) _CITY_MASTER_CI.set(String(c).toLowerCase().replace(/\s+/g, '_'), c);
function canonCity(t) {
  const raw = String(t || '').trim();
  if (!raw) return '';
  const us = raw.replace(/\s+/g, '_');                     // spaces → underscores (master format)
  if (_CITY_MASTER_SET.has(raw)) return raw;               // exact
  if (_CITY_MASTER_SET.has(us)) return us;                 // exact after underscore
  const key = raw.toLowerCase().replace(/\s+/g, '_');
  if (_CITY_ALIAS[key]) return _CITY_ALIAS[key];           // known spelling/district alias
  if (_CITY_MASTER_CI.has(key)) return _CITY_MASTER_CI.get(key);   // case-only diff → canonical
  const dkey = key.replace(/[–—]/g, '_');        // en/em-dash → _ ("medchal–malkajgiri")
  if (dkey !== key && _CITY_ALIAS[dkey]) return _CITY_ALIAS[dkey];
  // WHITELIST (USER 2026-09 city report #3): the LUCA importer rejects any city not
  // in its master, so a best-effort underscored non-master token ("MUM_Bad",
  // "SOUTH_TRIPURA", "West_UP", district names …) only adds invalid rows. Drop it —
  // the row's included_rto / included_states still carry the location. Salvageable
  // spellings/districts are mapped via config/luca_city_alias.json above.
  return '';
}

// A row that is INGEST GARBAGE, not a rate: the generic parser sometimes reads a
// grid's HEADER row as data (region = a cover/column label like "Comp /SATP
// (Net)", "RTO Cluster Name", "State Name", "BIKE_COMP") or scrambles a matrix so
// a rate-number string lands in region/segment ("7.5 8", "0.575 0.55"). Such rows
// carry no usable dimension and pollute the file with blank-location look-alikes.
// No legitimate region/segment matches these, so dropping them is safe (USER
// 2026-09: "give full clean file"). Insurers whose whole sheet is mis-ingested are
// handled by luca-config-expand SUPPRESS + a config resolver; this is the catch-all.
const _NUM_ONLY = /^[\d.]+(?:\s+[\d.]+)+$/;                        // "7.5 8", "12 20 20"
const _HDR_REGION = /\(\s*net\s*\)|rto\s*cluster\s*name|^\s*state\s*name\s*$|^(?:non[\s-]?new\s*)?(?:comp|package|satp|saod)\s*\/?\s*(?:comp|satp|saod|tp|od|net|only)?\s*(?:\(net\))?$|^(?:bike|sc|scooter)_(?:comp|tp|satp|saod)$/i;
function isGarbageRow(r) {
  const reg = String(r.region || '').trim();
  if (_HDR_REGION.test(reg) || _NUM_ONLY.test(reg)) return true;
  if (_NUM_ONLY.test(String(r.segment || '').trim())) return true;
  return false;
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

// Canonicalise a make token to LUCA's master brand spelling (USER 2026-09, LUCA
// import Row 4): bare "Hero" matches neither "Hero Honda" nor "Hero MotoCorp" —
// map it to Hero MotoCorp; "Mercedes"→Mercedes-Benz, "Rover"→Land Rover. Keyed on
// the token's upper-cased alnum form; only fires on the EXACT bare token (so
// "Hero Honda"/"Land Rover"/"Range Rover" pass through untouched).
const MAKE_CANON = {
  HERO: 'Hero MotoCorp', MERCEDES: 'Mercedes-Benz', ROVER: 'Land Rover',
  // USER 2026-09, LUCA import #5: brands whose internal spaces/spelling were lost.
  LANDROVER: 'Land Rover', MERCEDESBENZ: 'Mercedes-Benz', ROLLSROYCE: 'Rolls Royce',
  SSANGYONG: 'SsangYong', SSANGYONGMOTOR: 'SsangYong', KIAMOTORS: 'Kia',
  MARUTISUZUKI: 'Maruti Suzuki', SMLISUZU: 'SML Isuzu', CITRONE: 'Citroen',
  CITROEN: 'Citroen', VOLKS: 'Volkswagen',
  // USER 2026-09 make report: real brands emitted in lower/short form → LUCA master
  // spelling. "jawa" → the master's "Jawa Motors"; the rest are new EV/marque brands.
  JAWA: 'Jawa Motors', KIA: 'Kia', ATHER: 'Ather', BYD: 'BYD', CADILLAC: 'Cadillac',
  TESLA: 'Tesla', MG: 'MG', MINI: 'Mini', OLA: 'Ola Electric', ULTRAVIOLETTE: 'Ultraviolette',
};
// Model strings that leaked into the make column and are not brands → drop (blank
// make). "I20 Max 2" is a Bajaj SATP model list; hero vida / tvs iqube / bajaj
// chetak are models; "bike" a category, "alto" a model (USER 2026-09, LUCA #6).
const MAKE_BLOCK = new Set(['I20', 'MAX2', 'I20MAX2', 'HEROVIDA', 'TVSIQUBE',
  'BAJAJCHETAK', 'BIKE', 'ALTO',
  // USER 2026-09 make report: unrecoverable/truncated garbage in the make column.
  'NZD', 'MAXPO']);
// Leading-brand reduction: a make cell that packs "brand + model" ("Maruti Alto")
// → the brand only (model belongs in vehicle_model). Only brands whose bare name
// IS the LUCA make are listed, to avoid clobbering real multi-word makes
// ("Ashok Leyland", "Land Rover"). USER 2026-09 make report.
const MAKE_LEADING = { MARUTI: 'Maruti Suzuki' };

// Luca keeps make (manufacturer) and model as SEPARATE fields, but some grids
// put the MODEL in the make column: Bajaj files make = model = "Thar", ICICI
// files make = "Omni" with an empty model. Map the model back to its maker so
// vehicle_make is a real manufacturer and vehicle_model carries the model.
// Only well-known models are listed — an unmapped value is left untouched
// rather than risk asserting the wrong manufacturer to an agent.
const MODEL_TO_MAKE = {
  // Maruti Suzuki ("ecco"/"eeco" = Eeco misspelled, leaked into make col — USER 2026-09)
  'OMNI': 'Maruti Suzuki', 'CIAZ': 'Maruti Suzuki', 'IGNIS': 'Maruti Suzuki',
  'JIMNY': 'Maruti Suzuki', 'GRAND VITARA': 'Maruti Suzuki', 'ECCO': 'Maruti Suzuki', 'EECO': 'Maruti Suzuki',
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
  // Car SEGMENT tiers parked in the model column (TATA) — not models (USER 2026-09,
  // LUCA import #1: 2,923 rows). LUCA matches the real model (Nexon/Altroz), so a
  // segment label matches nothing — blank it.
  if (/^(HIGH\s*END|ULTRA\s*HIGH\s*END|MID\s*SIZE|COMPACT|MPV\s*SUV|MINI|QUADRICYCLE|SEDAN|HATCHBACK|SUV|MUV|LUXURY)$/.test(u)) return '';
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
  if (/^ALL\b/.test(u) || /^NON[\s-]/.test(u) || /^NOT\s/.test(u)) return false;    // "All ..." / "Non Tata" / "Not Maruti" (exclusion text)
  if (/^(SCOOTER|SCOOTY|MOTOR\s*CYCLE|MOTORCYCLE|MOPED|\bCAR\b)$/.test(u)) return false; // vehicle category, not a make
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
  const stripped = raw.replace(/\([^)]*\)/g, ' ')                   // drop "(including …)" notes
    .replace(/^\s*HEV[\s-]+/i, ' ')                                 // stray "hev-" prefix → drop ("hev-Mercedes Benz" → Mercedes-Benz)
    .replace(/\s*\bOEM\b\s*/ig, ' ');                               // "Yamaha OEM" → "Yamaha" (LUCA master has no OEM variants)
  const out = []; const seen = new Set();
  for (const part of stripped.split(/\s*(?:,|&|\/|\band\b)\s*/i)) {
    const s = part.trim();
    if (!s || !_isRealMakeToken(s)) continue;
    const alnum = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (MAKE_BLOCK.has(alnum)) continue;                    // model leaked into make → drop
    // "brand + model" packed in one cell ("Maruti Alto") → the brand only.
    const lead = MAKE_LEADING[s.trim().split(/\s+/)[0].toUpperCase()];
    const exp = lead || MAKE_CANON[alnum] || expandMake(s); // brand-lead, canonical brand, else expand abbrev
    const key = exp.toUpperCase();
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
  if (/\bUSED\b|SECOND[\s-]?HAND|PRE[\s-]?OWNED|\bOLD\b/.test(hay)) return 'used_car';
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
  // LUCA registers Telangana under TS-, not TG- (USER 2026-09, LUCA import: 39
  // distinct TG- codes fully dead). Canonicalise TG → TS.
  const pfx = m[1] === 'TG' ? 'TS' : m[1];
  return pfx + '-' + String(parseInt(m[2], 10)).padStart(2, '0');
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

// Liberty prices TP by product-specific GEO-CLUSTERS (region = "GUJARAT - 3 RBJB",
// "MAHARASHTRA - 5 R" …). The SAME RTO sits in a DIFFERENT cluster depending on the
// product group — Pvt Car/TW vs light GCV(≤7.5T)/PCV-3W vs heavy GCV(>7.5T) — so the
// single RTO→cluster row in rto_mappings can't resolve them all; the unmapped
// clusters collapse to the bare state and distinct per-zone rates collide into Luca
// conflicts. config/liberty_geo_cluster.json holds the 3 product columns from
// Liberty's "Geo Cluster" master, each {cluster→RTO list}. Pick the column by
// product group so every cluster gets its real, distinct RTOs (USER 2026-08).
const LIBERTY_GEO = (() => {
  try { return require('../config/liberty_geo_cluster.json') || {}; }
  catch (_) { return {}; }
})();
function libertyClusterRtos(canon, r, region) {
  let grp = null;
  if (canon === 'CAR' || canon === 'TW') grp = 'pc_tw';
  else if (canon === 'GCV') {
    const hay = `${r.segment || ''} ${r.sub_type || ''}`.toUpperCase();
    if (/3\s*W|3\s*WHEEL|THREE\s*WHEEL/.test(hay)) grp = 'gcv_light';        // GCV 3W → col G
    else grp = (Number(r.weight_band_max) > 7.5) ? 'gcv_heavy' : 'gcv_light'; // >7.5T → col H
  }
  if (!grp) return '';
  const tbl = LIBERTY_GEO[grp];
  return (tbl && tbl[_normKey(region)]) || '';
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
  // Snapshot period: stamp every row's year/month with this date (the effective
  // date the file was pulled for) instead of the source card's filing month.
  const asOf = (opts && opts.asOfDate && /^\d{4}-\d{2}-\d{2}$/.test(String(opts.asOfDate)))
    ? new Date(String(opts.asOfDate) + 'T00:00:00') : null;
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
    // For a snapshot file (asOfDate set) the config expanders must evaluate
    // date-gated rules AS OF THE SNAPSHOT, not each card's generation date — else a
    // rule effective after the newest card (e.g. United EV 35% eff 1-Sept, whose
    // only card is May) never fires. Use the snapshot date; the card's month is
    // stamped separately from asOfDate. Falls back to the card eff when no asOf.
    const _asOfStr = (opts && opts.asOfDate && /^\d{4}-\d{2}-\d{2}$/.test(String(opts.asOfDate)))
      ? String(opts.asOfDate) : null;
    for (const e of effRs.recordset) effByInsurer.set(e.insurer, _asOfStr || e.eff);
  }
  const configRows = expandConfigRules(effByInsurer);
  // Drop DB rows the resolvers REPLACE (e.g. Tata's never-ingested Private Car
  // sheet and mis-ingested CV sheet) — otherwise the file would carry rates the
  // engine never pays alongside the correct config-expanded ones.
  const dbRows = result.recordset.filter(r => !isSuppressed(r));

  // Liberty TW comprehensive is owned by the "TW SATP MC" grid (rate_type COMP, flat
  // ~0.54) where it exists; the Robinhood grid's PACK_LIBERTY_OD (the comp OD leg,
  // region-specific 0.43/0.48) duplicates the same coverage with a DIFFERENT rate →
  // 38 Luca conflicts. Per USER 2026-08 the TW SATP MC COMP wins. Build the set of
  // region+segment the COMP grid actually covers, and drop ONLY the matching OD-leg
  // rows below — so the ~41 regions the COMP grid omits keep their Robinhood comp.
  const _libTwCompCov = new Set();
  for (const r of dbRows) {
    if (/liberty/i.test(String(r.insurer || '')) && String(r.product || '').toUpperCase() === 'TW'
        && /^COMP$/i.test(String(r.rate_type || ''))) {
      _libTwCompCov.add(_normKey(r.region) + '|' + _normKey(r.segment));
    }
  }

  const rows = [LUCA_HEADERS.slice()];
  const _emitted = new Set();   // output-level dedupe (see the push below)
  let id = 1;
  for (const r of dbRows.concat(configRows)) {
    // Drop the duplicate Robinhood TW comp OD leg where the TW SATP MC COMP wins.
    if (/liberty/i.test(String(r.insurer || '')) && String(r.product || '').toUpperCase() === 'TW'
        && /^PACK_LIBERTY_OD$/i.test(String(r.rate_type || ''))
        && _libTwCompCov.has(_normKey(r.region) + '|' + _normKey(r.segment))) continue;
    const insurer = lucaInsurer(r.insurer || '');
    if (!insurer) continue;   // insurer has no canonical Luca slug (kiwi, kshema) → excluded
    if (isGarbageRow(r)) continue;   // ingest artifact (header/rate-number in region/segment)
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
    // opts.flatMargin (USER): a single flat margin (in points) applied to EVERY
    // rule, overriding the per-rule company margin — e.g. a 5% flat margin makes
    // outgoing = grid - 5 for all rows. Falls back to the per-rule margin when unset.
    const marginP = (opts && opts.flatMargin != null && Number.isFinite(Number(opts.flatMargin)))
      ? Number(opts.flatMargin)
      : marginPctForRule(r, canonVt(vt), marginRules, marginCache);
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
    // Liberty & HDFC encode NEW business as an age band of exactly [0,0] (paired with
    // a [1,99] rollover tier) and NO 1+5/bundled keyword — so a new-vehicle
    // comprehensive policy, which is really a bundled long-term package, was falling
    // to 'comprehensive'. Treat their Comp rows with age [0,0] as hybrid. Scoped to
    // these two on purpose: for most insurers a bare [0,0] is a no-age-dimension
    // default (magma/sbi/bajaj CAR carry thousands), NOT "new" (USER 2026-08).
    const isNewTierZero = /liberty|hdfc/i.test(String(r.insurer || ''))
      && r.age_band_min != null && r.age_band_max != null
      && Number(r.age_band_min) === 0 && Number(r.age_band_max) === 0;
    const isBundled = /BUNDL|LONG[\s-]?TERM|\bLT\b/.test(covHay)
                   || (bt && +bt[1] >= 1 && +bt[1] <= 5 && +bt[2] >= 2 && +bt[2] <= 5)
                   || isNewTierZero;
    const coverageType = cover === 'Comp' ? (isBundled ? 'hybrid' : 'comprehensive')
                       : cover === 'SAOD' ? 'own_damage'
                       : 'third_party';
    // NB: bundle tenure (1+5 / 5+5) is deliberately NOT written to the slab/tenure
    // column — USER 2026-08 asked to leave it blank for now. (This means 1+5 vs 5+5
    // bundles on the same cell can still look like a Luca conflict; revisit later.)
    // year/month = the SNAPSHOT period (opts.asOfDate) when the file is an
    // "as-of <date>" export, NOT each rule's source-card filing month. A Sept
    // snapshot is all 2026-Sep even for insurers whose in-force grid was filed in
    // March (USER: "it showing all months"). Falls back to the source date.
    const d = asOf || (r.effective_from ? new Date(r.effective_from) : null);
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
    // Liberty product-specific geo-cluster (authoritative over the generic
    // rto_mappings resolve above, which can't tell light vs heavy GCV apart).
    if (/liberty/i.test(String(r.insurer || ''))) {
      const rl = libertyClusterRtos(canonVt(vt), r, region);
      if (rl) rtoList = rl;
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
    // LUCA registers Telangana as TS- (not TG-); some paths (Liberty geo-cluster)
    // build the RTO list without normRto, so canonicalise the finished list here.
    if (rtoList) rtoList = String(rtoList).replace(/\bTG-/g, 'TS-');

    const _prod = lucaProduct(vt, r.segment, r.sub_type, r.sheet_name, r.weight_band_min, r.weight_band_max);
    const rowArr = [
      0,                                                      // id — assigned below after the dedupe check
      (insurer + vt + (cover === 'Comp' ? 'PACKAGE' : cover.toUpperCase())).toUpperCase().replace(/[^A-Z0-9]/g, ''), // name
      insurer,                                                // insurers
      d ? d.getFullYear() : '',                               // year
      d ? MONTHS[d.getMonth()] : '',                          // month
      _prod,                                                  // products
      coverageType,                                           // coverage_type
      lucaNcb(r.rate_type),                                   // ncb
      // commission_on: which premium the payout applies to. NET for GCV (all goods
      // carriers) and for ALL of United India (every product) — USER 2026-09; other
      // insurers/products carry the single leg.
      (/^gcv/.test(_prod) || /united/i.test(String(insurer))) ? 'NET' : (isTp ? 'TP' : 'OD'), // commission_on
      // USER 2026-08: each row carries a SINGLE commission (TP-only, OD-only, or a
      // Net rate where OD & TP aren't split) → it goes in irdai_commission_percentage.
      // tp_commission_percentage is used ONLY when a row genuinely carries SEPARATE
      // OD and TP legs (OD→irdai, TP→tp) — which the one-rate-per-row export never
      // produces, so it stays blank here.
      '',                                                     // tp_commission_percentage
      rateP,                                                  // irdai_commission_percentage (the single outgoing rate)
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
      // vehicle_age — [min,max]. A HYBRID row is a bundled long-term package
      // (1+3 / 1+5 / 5+5), always written on a BRAND-NEW vehicle → age ZERO
      // (USER 2026-08: set 0, was blank). Non-hybrid covers keep their band.
      coverageType === 'hybrid' ? ageBand(0, 0)                               // vehicle_age
        : (ageBand(r.age_band_min, r.age_band_max)
           || (function () { const b = ageBandFromSegment(r.segment); return b ? ageBand(b[0], b[1]) : ''; })()),
      // Two-wheelers have no meaningful seating band — blank it (USER 2026-09,
      // LUCA #4: ICICI scooter rows carried a wrong [6,7] seating).
      (canonVt(vt) === 'TW' ? '' : seatBand(r.seating_capacity_min, r.seating_capacity_max)),  // seating_capacity
      gvwBand(r.weight_band_min, r.weight_band_max),                            // gross_vehicle_weight (kg)
      lucaFuel(r.fuel_type),                                  // fuel_type
      lucaBusinessType(r.segment, r.sub_type, r.rate_type),   // business_type
      '',                                                     // zones
      lucaState(r.state, r.region, r.sub_type),               // included_states (canonical state slug)
      cleanCity(citiesFromRtoList(rtoList) || lucaCity(region)),   // city — real cities only (drop cluster codes / state names LUCA can't match)
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
      // Strip embedded newlines/tabs: a REMARK with a line break splits a row when
      // the file is saved/read as CSV, misaligning the id column → the Luca importer
      // then reports non-unique / missing ids (USER 2026-09).
      ([[r.segment, r.sub_type].map(x => String(x || '').trim()).filter(Boolean).join(' ').trim(),
        String(r.remarks || '').trim()].filter(Boolean).join(' | ')).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 250),  // REMARK / comment
    ];
    // Output-level dedupe (USER: "it looks duplicate records"). Different source
    // rate_rules can render to a byte-identical Luca row — e.g. two rows that
    // differ only in a column Luca doesn't carry (sub_type). Identical on every
    // agent-visible column = indistinguishable, so emit it once. Key on the whole
    // row EXCEPT the id (index 0) and the REMARK (last col — free text, not a
    // rate dimension, so it shouldn't create a phantom "distinct" row).
    const sig = rowArr.slice(1, rowArr.length - 1).join('').toUpperCase();
    if (_emitted.has(sig)) continue;
    _emitted.add(sig);
    rowArr[0] = id++;
    rowArr._vt = String(r.volume_tier || '');   // source volume tier (for the slab-collapse below)
    // Source card date (NOT the stamped snapshot month) — used by the engine-match
    // de-conflict below to keep the newest generation when rows collapse.
    rowArr._eff = r.effective_from ? new Date(r.effective_from).getTime() : 0;
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
          row[I_RTO] = remaining.join(',').replace(/\bTG-/g, 'TS-');
          row[I_CITY] = cleanCity(citiesFromRtoList(row[I_RTO]) || row[I_CITY]);
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
    const collKey = (row) => (KEY_COLS.map((i) => String(row[i])).join('|') + '|' + String(row[I_RTO])).toUpperCase();  // case-insensitive: TATA==Tata
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
      } else if (/bajaj|icici|royal|chola/i.test(String(grp[0][I_INS] || ''))) {
        // Same exact cell+RTO at different rates, collapse to the HIGHER rate:
        //  - Bajaj: duplicated per-RTO override (base-with-note vs explicit row).
        //  - ICICI: MHCV truck-body variants (Tanker/Tipper/Trailer/Truck).
        //  - Royal: OD-discount bands whose distinguisher (volume_tier) is now blank.
        //  - Chola: our NOP-volume tiers ("100-500 NOP" …) carried in the segment.
        // (USER 2026-08: agent payout doesn't depend on OUR volume/discount band.)
        // Scoped so Go Digit bundles (differ by tenure) are left untouched.
        best = grp[0];
        for (const r0 of grp) if (rateOf(r0) > rateOf(best)) best = r0;
      } else {
        // Engine-match de-conflict (USER 2026-09): same cell + RTO + volume tier at
        // different rates = the source has >1 grid GENERATION or overlapping CLUSTER
        // collapsing onto one Luca identity (e.g. Kotak "RTO Level TP ULR" LCV grid
        // vs "GCV Pan India"; Liberty two geo-clusters on the same RTOs; Go Digit HEV
        // from two clusters). The engine pays the NEWEST generation, so keep the row
        // from the newest source card; tie on date → keep the higher rate (agent-safe,
        // deterministic). Resolves the look-alike duplicates the agent can't tell apart.
        best = grp[0];
        for (const r0 of grp) {
          const de = (r0._eff || 0) - (best._eff || 0);
          if (de > 0 || (de === 0 && rateOf(r0) > rateOf(best))) best = r0;
        }
      }
      for (const r0 of grp) if (r0 !== best) dropped.add(r0);
    }
    const kept2 = kept.filter((row, i) => i === 0 || !dropped.has(row));

    rows.length = 0;
    for (const row of kept2) rows.push(row);
  }

  // (Removed the old exclusive-end cc gap-closer that bumped [1000,1500]->[1000,1501]
  // to make ladders touch. Under the INCLUSIVE convention (USER 2026-09) a ladder
  // [1000,1500]/[1501,null] already covers 1500 with no shared boundary, and that
  // bump was what produced the spurious shared 1501.)

  // Resolve overlapping bands — NARROWER band wins (USER 2026-09 report #3). Within a
  // family (identical in every column except this band + the two rate cols + REMARK),
  // two bands covering the same value at different rates leave LUCA to break the tie by
  // its own priority, not intent (e.g. age [5,null]@18 vs [6,null]@17; a GCV catch-all
  // [1,43000]@37.5 under specific weight tiers). Partition each family's number line so
  // the NARROWEST (most specific) band owns any overlap; wider/catch-all bands are
  // clipped to the remaining gaps (split into pieces, or dropped if fully covered).
  {
    const HI = (n) => LUCA_HEADERS.indexOf(n);
    const I_TP = HI('tp_commission_percentage'), I_IC = HI('irdai_commission_percentage'), I_REM = LUCA_HEADERS.length - 1;
    // Bands are INCLUSIVE (USER 2026-09): parse inclusive [lo,hi] into a half-open
    // [lo, hi+1) internally for the partition math, then emit back inclusive (hi-1)
    // so consecutive segments are [a,b]/[b+1,c] with NO shared boundary.
    const parseR = (v) => { const m = /^\[(\d+(?:\.\d+)?),(\d+(?:\.\d+)?|null)\]$/.exec(String(v || '')); return m ? [Number(m[1]), m[2] === 'null' ? Infinity : Number(m[2]) + 1] : null; };
    const fmtR = (lo, hi) => `[${lo},${hi === Infinity ? 'null' : hi - 1}]`;
    const resolveCol = (bi) => {
      const famCols = LUCA_HEADERS.map((_, i) => i).filter((i) => i !== 0 && i !== bi && i !== I_TP && i !== I_IC && i !== I_REM);
      const fams = new Map(); const keep = [rows[0]];
      for (const row of rows.slice(1)) {
        const rng = parseR(row[bi]);
        if (!rng) { keep.push(row); continue; }                    // blank / non-range → passthrough
        const k = famCols.map((i) => String(row[i] == null ? '' : row[i])).join('');
        if (!fams.has(k)) fams.set(k, []);
        fams.get(k).push({ row, lo: rng[0], hi: rng[1] });
      }
      for (const members of fams.values()) {
        if (members.length === 1) { keep.push(members[0].row); continue; }
        const pts = [...new Set(members.flatMap((m) => [m.lo, m.hi]))].sort((a, b) => a - b);
        const width = (m) => m.hi - m.lo;                          // narrower = smaller span; tie → higher lo (starts later)
        const rateOf = (m) => { const v = m.row[I_IC]; return (v !== '' && v != null) ? Number(v) : Number(m.row[I_TP]); };
        const owned = new Map(members.map((m) => [m, []]));
        for (let k = 0; k < pts.length - 1; k++) {                 // elementary segment [a,b)
          const a = pts[k], b = pts[k + 1]; if (a >= b) continue;
          const cov = members.filter((m) => m.lo <= a && m.hi >= b);
          if (!cov.length) continue;
          cov.sort((x, y) => (width(x) - width(y)) || (y.lo - x.lo) || (rateOf(y) - rateOf(x)));
          owned.get(cov[0]).push([a, b]);                          // narrowest covering band owns this segment
        }
        for (const m of members) {
          const segs = owned.get(m); if (!segs.length) continue;   // band fully covered by narrower ones → dropped
          segs.sort((x, y) => x[0] - y[0]);
          const mg = []; for (const s of segs) { if (mg.length && mg[mg.length - 1][1] === s[0]) mg[mg.length - 1][1] = s[1]; else mg.push([s[0], s[1]]); }
          for (const [lo, hi] of mg) { const nr = m.row.slice(); nr[bi] = fmtR(lo, hi); keep.push(nr); }
        }
      }
      rows.length = 0; for (const r of keep) rows.push(r);
    };
    for (const c of ['vehicle_age', 'gross_vehicle_weight', 'vehicle_cc', 'seating_capacity']) resolveCol(HI(c));
  }

  // Collapse location rows (USER 2026-09): per-RTO grids (Kotak SATP = 36k rows)
  // emit one row PER RTO that are otherwise identical (same rate, product, cover,
  // make, cc, fuel …). Merge every set of rows equal in all rate/dimension columns
  // into ONE row whose included_rto / city / included_states carry the comma-joined
  // (deduped) union. The per-RTO REMARK ("Scooter AP14 | … | AP14 | …") is the same
  // apart from the embedded RTO code, so we generalise it (strip standalone RTO
  // codes) BEFORE keying — rows whose remark still differs after that stay separate,
  // so nothing is lost. Kotak 36,719 → ~673 rows.
  {
    const HI = (n) => LUCA_HEADERS.indexOf(n);
    const I_RTO = HI('included_rto'), I_CITY = HI('city'), I_STATE = HI('included_states');
    const I_REM = LUCA_HEADERS.length - 1;
    const locSet = new Set([0, I_RTO, I_CITY, I_STATE, I_REM]);  // excluded from the merge key
    const keyCols = LUCA_HEADERS.map((_, i) => i).filter((i) => !locSet.has(i));
    // Generalise a REMARK by removing standalone RTO codes (AP14 / AP-14 / MH 12)
    // and tidying the leftover separators, so per-RTO remarks collapse to one.
    const genRemark = (s) => String(s == null ? '' : s)
      .replace(/\b[A-Z]{2}[-\s]?\d{1,3}\b/g, ' ')
      .replace(/\s*\|\s*(?=\|)/g, '').replace(/\|\s*$/,'').replace(/^\s*\|/,'')
      .replace(/\s{2,}/g, ' ').replace(/\s*\|\s*/g, ' | ').trim();
    const splitAdd = (set, v) => String(v == null ? '' : v).split(',').map((x) => x.trim()).filter(Boolean).forEach((x) => set.add(x));
    const groups = new Map(); const order = [];
    for (const row of rows.slice(1)) {
      const gr = genRemark(row[I_REM]);
      const key = keyCols.map((i) => String(row[i] == null ? '' : row[i])).join('¦') + '¦' + gr;
      let g = groups.get(key);
      if (!g) { g = { row: row.slice(), rtos: new Set(), cities: new Set(), states: new Set(), rem: gr }; groups.set(key, g); order.push(g); }
      splitAdd(g.rtos, row[I_RTO]); splitAdd(g.cities, row[I_CITY]); splitAdd(g.states, row[I_STATE]);
    }
    if (order.length < rows.length - 1) {
      const merged = [rows[0]]; let nid = 1;
      for (const g of order) {
        const row = g.row;
        row[I_RTO] = [...g.rtos].join(',');
        row[I_CITY] = [...g.cities].join(',');
        row[I_STATE] = [...g.states].join(',');
        row[I_REM] = g.rem;
        row[0] = nid++;
        merged.push(row);
      }
      rows.length = 0; for (const r of merged) rows.push(r);
    }
  }

  // Reorder every row (header included) from build order to the Luca output order.
  const outRows = rows.map((row) => _OUT_IDX.map((i) => row[i]));
  const ws = XLSX.utils.aoa_to_sheet(outRows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true });
}

module.exports = {  buildLucaBuffer, LUCA_HEADERS, lucaProduct, lucaState, lucaFuel, lucaMake, lucaMakeModel, lucaBusinessType };
