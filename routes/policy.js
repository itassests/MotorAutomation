const express = require('express');
const sql = require('mssql');
const { getPool } = require('../db/connection');
const { getPrarambhPool } = require('../db/prarambh-connection');
const { lookupRates, resolveRTO, rtoProductFor } = require('../services/rate-lookup');
const { calculatePayout } = require('../services/calculator');

const router = express.Router();

/**
 * ICICI Lombard region aliases. The rto_mappings table and booking-location
 * column produce labels like "GURGAON" / "DELHI" / "Jammu" / "Motor Kolkata"
 * that don't exist verbatim in ICICI's rate card (which uses state and major-
 * city labels: "NCR", "JAMMU AND KASHMIR", "KOLKATA", etc.). When the resolved
 * region matches a key here, we substitute the first candidate before the SQL
 * lookup. The cluster-fallback chain still runs, so a wrong primary alias
 * just falls through harmlessly.
 *
 * Keys are upper-cased trimmed source labels.
 */
const ICICI_REGION_ALIASES = {
  // City / sub-cluster → ICICI region (primary is alias[0]; the rest are
  // tried in cluster fallback for product-specific variants).
  'GURGAON':         ['NCR', 'HARYANA'],
  'DELHI':           ['NCR'],
  'JANAKPURI WEST':  ['NCR'],
  'JANAKPURI':       ['NCR'],
  'JAMMU':           ['JAMMU AND KASHMIR', 'Jammu And Kashmir', 'JAMMUANDKASHMIR'],
  'AHMEDABAD':       ['AHMEDABAD', 'Ahmedabad & Gandhinagar', 'AHMEDABAD & GANDHINAGAR'],
  'MOTOR KOLKATA':   ['KOLKATA', 'Kolkata'],
  'MEERUT':          ['UTTAR PRADESH', 'Uttar Pradesh', 'UP-EAST', 'UP-WEST'],
  // State-name keys — used when the resolved region is already a state
  // name (e.g. booked-location alias resolved to "UTTAR PRADESH"). The
  // cluster fallback consults this map by `key` so all product-specific
  // variants get tried.
  'UTTAR PRADESH':   ['UP-EAST', 'UP-WEST', 'UTTAR PRADESH', 'Uttar Pradesh',
                      'KANPUR', 'Kanpur', 'LUCKNOW', 'Lucknow', 'ALLAHABAD',
                      'VARANASI', 'NCR'],
  'GUJARAT':         ['AHMEDABAD & GANDHINAGAR', 'Ahmedabad & Gandhinagar',
                      'AHMEDABAD', 'GUJARAT', 'Gujarat', 'BARODA', 'Baroda',
                      'SURAT', 'Surat', 'RAJKOT', 'Rajkot'],
  'MAHARASHTRA':     ['MAHARASHTRA', 'Maharashtra', 'MUMBAI', 'Mumbai',
                      'PUNE', 'Pune', 'NAGPUR', 'Nagpur', 'NASIK', 'Nashik'],
  'KARNATAKA':       ['KARNATAKA', 'Karnataka', 'BANGALORE', 'Bangalore',
                      'MYSORE', 'Mysore'],
  'TAMIL NADU':      ['TAMIL NADU', 'Tamil Nadu', 'CHENNAI', 'Chennai',
                      'COIMBATORE'],
  'KERALA':          ['KERALA', 'Kerala', 'COCHIN', 'Cochin'],
  'WEST BENGAL':     ['WEST BENGAL', 'West Bengal', 'KOLKATA', 'Kolkata'],
  'PUNJAB':          ['PUNJAB', 'Punjab', 'CHANDIGARH', 'Chandigarh',
                      'LUDHIANA', 'Ludhiana'],
  'HARYANA':         ['HARYANA', 'Haryana', 'NCR'],
  'BIHAR':           ['BIHAR', 'Bihar', 'PATNA', 'Patna'],
  'JHARKHAND':       ['JHARKHAND', 'Jharkhand', 'RANCHI', 'Ranchi'],
  'ODISHA':          ['ODISHA', 'Odisha', 'BHUBANESHWAR&CUTTAK',
                      'Bhubaneshwar & Cuttack'],
  'RAJASTHAN':       ['RAJASTHAN', 'Rajasthan', 'JAIPUR', 'Jaipur',
                      'JODHPUR', 'Jodhpur'],
  'MADHYA PRADESH':  ['MADHYAPRADESH', 'Madhya Pradesh', 'MADHYA PRADESH',
                      'INDORE', 'Indore'],
  'CHHATTISGARH':    ['CHHATTISGARH', 'Chhattisgarh'],
  'ANDHRA PRADESH':  ['ANDHRAPRADESH', 'ANDHRA PRADESH', 'Andhra Pradesh',
                      'HYDERABAD', 'VISHAKAPATTNAM', 'VIJAYWADA'],
  'TELANGANA':       ['TELANGANA', 'Telangana', 'HYDERABAD', 'Hyderabad'],
  'JAMMU AND KASHMIR': ['JAMMUANDKASHMIR', 'JAMMU AND KASHMIR',
                        'Jammu And Kashmir'],
};

/** Apply the alias map; returns the first candidate, or the original
 *  region when nothing maps. Case-insensitive lookup. */
function aliasIciciRegion(region) {
  if (!region) return region;
  const key = String(region).trim().toUpperCase();
  const aliases = ICICI_REGION_ALIASES[key];
  return (aliases && aliases.length > 0) ? aliases[0] : region;
}

/**
 * HDFC Ergo region aliases. Same idea as ICICI but with HDFC's labels:
 *   - Gujarat sub-cities (MEHSANA / HIMMATNAGAR) → "Rest of Gujarat"
 *   - Delhi sub-clusters (JANAK PURI / JANAKPURI WEST / GURGAON) → "Delhi NCR"
 * HDFC's CAR rate card currently only ships SATP rates, and PCV isn't loaded
 * at all, so aliasing won't recover those — those are real rate-card gaps.
 */
const HDFC_REGION_ALIASES = {
  'MEHSANA':         ['Rest of Gujarat', 'Ahemedabad, Surat'],
  'HIMMATNAGAR':     ['Rest of Gujarat'],
  'JANAK PURI':      ['Delhi NCR', 'NCR'],
  'JANAKPURI WEST':  ['Delhi NCR', 'NCR'],
  'JANAKPURI':       ['Delhi NCR', 'NCR'],
  'GURGAON':         ['Delhi NCR', 'NCR', 'Haryana'],
  'MOTOR KOLKATA':   ['Kolkata'],
  // Resolved-region keys (consulted directly when stateKey is empty —
  // e.g. RTO blank but booked location set). Each "Delhi NCR" lookup
  // also tries "NCR" since HDFC's Pvt Car Robinhood Comp grid only
  // lives under "NCR" while "Delhi NCR" holds TP-only rules.
  'DELHI NCR':       ['NCR', 'Delhi NCR'],
  'NCR':             ['NCR', 'Delhi NCR'],
};

/**
 * ICICI Lombard per-state fallback region candidates. ICICI's rate sheets
 * vary the region label by product:
 *   CAR:        "AHMEDABAD"             "JAMMU AND KASHMIR"
 *   TW:         "Ahmedabad & Gandhinagar"  "Jammu And Kashmir"
 *   GCV/PCV/MISC: "AHMEDABAD & GANDHINAGAR"  "JAMMUANDKASHMIR" (no spaces!)
 *                 "UP-EAST" / "UP-WEST" instead of "UTTAR PRADESH"
 *
 * The aliasIciciRegion() returns one primary; this fallback list adds the
 * remaining product-specific variants (and major-city / state-level regions)
 * so the cluster fallback can pick whichever ICICI uses for the policy's
 * product.
 */
const ICICI_STATE_FALLBACKS = {
  'GJ': ['AHMEDABAD', 'Ahmedabad & Gandhinagar', 'AHMEDABAD & GANDHINAGAR',
         'BARODA', 'Baroda', 'SURAT', 'Surat', 'RAJKOT', 'Rajkot',
         'GUJARAT', 'Gujarat'],
  'DL': ['NCR', 'Ncr'],
  'HR': ['HARYANA', 'Haryana', 'NCR', 'Ncr'],
  'UP': ['UTTAR PRADESH', 'Uttar Pradesh', 'UP-EAST', 'UP-WEST',
         'KANPUR', 'Kanpur', 'LUCKNOW', 'Lucknow',
         'ALLAHABAD', 'Allahabad', 'VARANASI', 'Varanasi'],
  'JK': ['JAMMU AND KASHMIR', 'Jammu And Kashmir', 'JAMMUANDKASHMIR'],
  'MH': ['MAHARASHTRA', 'Maharashtra', 'MUMBAI', 'Mumbai',
         'PUNE', 'Pune', 'NAGPUR', 'Nagpur', 'NASIK', 'Nashik'],
  'WB': ['WEST BENGAL', 'West Bengal', 'KOLKATA', 'Kolkata'],
  'TN': ['TAMIL NADU', 'Tamil Nadu', 'CHENNAI', 'Chennai',
         'COIMBATORE', 'Coimbatore'],
  'KA': ['KARNATAKA', 'Karnataka', 'BANGALORE', 'Bangalore',
         'MYSORE', 'Mysore', 'MANGALORE'],
  'AP': ['ANDHRA PRADESH', 'ANDHRAPRADESH', 'Andhra Pradesh',
         'HYDERABAD', 'Hyderabad', 'VISHAKAPATTNAM', 'VIJAYWADA'],
  'TS': ['TELANGANA', 'Telangana', 'HYDERABAD', 'Hyderabad'],
  'TG': ['TELANGANA', 'Telangana', 'HYDERABAD', 'Hyderabad'],
  'RJ': ['RAJASTHAN', 'Rajasthan', 'JAIPUR', 'Jaipur', 'JODHPUR', 'Jodhpur'],
  'PB': ['PUNJAB', 'Punjab', 'CHANDIGARH', 'Chandigarh',
         'LUDHIANA', 'Ludhiana'],
  'CH': ['CHANDIGARH', 'Chandigarh', 'PUNJAB', 'Punjab'],
  'MP': ['MADHYA PRADESH', 'MADHYAPRADESH', 'Madhya Pradesh',
         'INDORE', 'Indore'],
  'CG': ['CHHATTISGARH', 'Chhattisgarh'],
  'BR': ['BIHAR', 'Bihar', 'PATNA', 'Patna'],
  'JH': ['JHARKHAND', 'Jharkhand', 'RANCHI', 'Ranchi'],
  'OD': ['ODISHA', 'Odisha', 'BHUBANESHWAR&CUTTAK', 'Bhubaneshwar & Cuttack'],
  'OR': ['ODISHA', 'Odisha'],
  'KL': ['KERALA', 'Kerala', 'COCHIN', 'Cochin'],
  'HP': ['HIMACHALPRADESH', 'Himachal Pradesh'],
  'UK': ['UTTARAKHAND', 'Uttarakhand', 'DEHRADUN', 'Dehradun'],
  'GA': ['GOA', 'Goa'],
  'AS': ['ASSAM', 'Assam', 'GUWAHATI', 'Guwahati'],
  'GJ_UT_DD': ['DAMAN', 'GUJARAT', 'Gujarat'],
  'DD': ['DAMAN', 'GUJARAT', 'Gujarat'],
  'DN': ['DADRA & NAGAR HAVELI', 'GUJARAT', 'Gujarat'],
  'AN': ['ANDAMAN&NICOBAR'],
};

/** Returns ICICI Lombard fallback regions for an RTO state prefix. */
function getIciciStateFallbacks(stateKey) {
  if (!stateKey) return [];
  return ICICI_STATE_FALLBACKS[String(stateKey).toUpperCase()] || [];
}

function aliasHdfcRegion(region) {
  if (!region) return region;
  const key = String(region).trim().toUpperCase();
  const aliases = HDFC_REGION_ALIASES[key];
  return (aliases && aliases.length > 0) ? aliases[0] : region;
}

/**
 * Shriram GCV/PCV grids label regions with verbose multi-state strings, e.g.
 * "GUJARAT & DADRA NAGAR HAVELI & DAMAN & DIU", "TAMILNADU & PONDICHERRY",
 * "PUNJAB/CHANDIGARH", "MUMBAI", "ROM". The engine resolves a plain state name
 * ("Gujarat"/"Maharashtra") from the RTO prefix, which never matches those
 * labels under strict equality — so the lookup falls through to an arbitrary
 * wrong-state rate.
 *
 * This resolver maps the plain state (+ RTO for the Maharashtra split) to a set
 * of SEARCH TOKENS that are matched against the card label with 'contains'
 * (substring) mode. Tokens are deliberately short/distinctive substrings of the
 * verbose labels (e.g. 'GUJARAT', 'TAMIL', 'PONDICHERRY') and cover known
 * spelling variants (KERELA/KERALA, ORISSA/ODISHA, CHATTISGARH/CHHATTISGARH,
 * UTTARANCHAL/UTTARAKHAND). North-East small states share an "ASSAM & NE"
 * grouping, so they fall back to 'ASSAM' as well.
 *
 * Maharashtra split (per product owner): Mumbai-metro RTOs → 'MUMBAI', the rest
 * of the state → 'ROM' (Rest of Maharashtra).
 */
const SHRIRAM_MUMBAI_RTOS = new Set(['MH01', 'MH02', 'MH03', 'MH04', 'MH43', 'MH46', 'MH47', 'MH48']);
const SHRIRAM_REGION_TOKENS = {
  'GUJARAT': ['GUJARAT'],
  'TAMIL NADU': ['TAMIL'],
  'TAMILNADU': ['TAMIL'],
  'PUDUCHERRY': ['PONDICHERRY', 'PUDUCHERRY'],
  'PONDICHERRY': ['PONDICHERRY', 'PUDUCHERRY'],
  'KERALA': ['KERALA', 'KEREL'],
  'KERELA': ['KERALA', 'KEREL'],
  'ODISHA': ['ODISHA', 'ORISSA'],
  'ORISSA': ['ODISHA', 'ORISSA'],
  'CHHATTISGARH': ['CHHATTISGARH', 'CHATTISGARH', 'CHATISGARH'],
  'CHATTISGARH': ['CHHATTISGARH', 'CHATTISGARH', 'CHATISGARH'],
  'UTTARAKHAND': ['UTTARAKHAND', 'UTTARANCHAL'],
  'UTTARANCHAL': ['UTTARAKHAND', 'UTTARANCHAL'],
  'PUNJAB': ['PUNJAB'],
  'CHANDIGARH': ['CHANDIGARH'],
  'DELHI': ['DELHI', 'NCR'],
  'ANDHRA PRADESH': ['ANDHRA'],
  'TELANGANA': ['TELANGANA', 'TELANGNA'],
  'JAMMU & KASHMIR': ['J & K', 'J&K', 'JAMMU'],
  'JAMMU AND KASHMIR': ['J & K', 'J&K', 'JAMMU'],
  'WEST BENGAL': ['WEST BENGAL', 'BENGAL'],
  'MADHYA PRADESH': ['MADHYA'],
  'HIMACHAL PRADESH': ['HIMACHAL'],
  'ARUNACHAL PRADESH': ['ARUNACHAL', 'ASSAM'],
  'TRIPURA': ['TRIPURA', 'ASSAM'],
  'MEGHALAYA': ['MEGHALAYA', 'ASSAM'],
  'MIZORAM': ['MIZORAM', 'ASSAM'],
  'NAGALAND': ['NAGALAND', 'ASSAM'],
  'MANIPUR': ['MANIPUR', 'ASSAM'],
  'SIKKIM': ['SIKKIM', 'ASSAM'],
  'ASSAM': ['ASSAM'],
};
function aliasShriramRegion(stateFull, rtoCode) {
  const s = String(stateFull || '').trim().toUpperCase();
  const pfx = String(rtoCode || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2);
  // Daman & Diu (DD) and Dadra & Nagar Haveli (DN) are administered with Gujarat
  // in Shriram's grid (label "GUJARAT & DADRA NAGAR HAVELI & DAMAN & DIU"); the
  // plain state names ("Daman and Diu" / "Dadra and Nagar Haveli") never match.
  // Route them to the GUJARAT token (which substring-matches both the plain
  // "GUJARAT" region and the bundled label).
  if (pfx === 'DD' || pfx === 'DN' || /\bDAMAN\b|\bDADRA\b|NAGAR\s+HAVELI/.test(s)) {
    return ['GUJARAT'];
  }
  if (!s) return null;
  if (s === 'MAHARASHTRA') {
    const norm = String(rtoCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    // norm like "MH20", "MH01" — keep the first 4 chars (state+2 digits)
    const key = norm.slice(0, 4);
    return SHRIRAM_MUMBAI_RTOS.has(key) ? ['MUMBAI'] : ['ROM'];
  }
  return SHRIRAM_REGION_TOKENS[s] || [s];
}

/**
 * Shriram RTO-level decline / exclusion encoded in a rule remark, e.g.
 *   "UP 70, 75, 79, 82, 84, 95 IS DECLINED | UP 11 EXCLUDED (PART OF UK-RSD)"
 * Returns true when the policy's RTO district number is listed (DECLINED or
 * EXCLUDED) for its own state prefix — meaning the insurer won't write that
 * district under this grid row, so the policy must be DECLINED (not rated, and
 * not fallen back to another region's rule).
 */
function shriramRtoDeclined(remark, rtoCode) {
  const rem = String(remark || '').toUpperCase();
  if (!rem || !/DECLINED|EXCLUDED/.test(rem)) return false;
  const rc   = String(rtoCode || '').toUpperCase();
  const pPfx = rc.replace(/[^A-Z]/g, '').slice(0, 2);
  const pNumM = rc.match(/(\d+)/);
  const pNum  = pNumM ? String(parseInt(pNumM[1], 10)) : null;
  if (!pPfx || pNum == null) return false;
  const re = /\b([A-Z]{2})\s+((?:\d+\s*,\s*)*\d+)\s*(?:IS\s+)?(?:DECLINED|EXCLUDED)/g;
  let mm;
  while ((mm = re.exec(rem)) !== null) {
    if (mm[1] !== pPfx) continue;
    const nums = mm[2].split(',').map(s => String(parseInt(s.trim(), 10)));
    if (nums.includes(pNum)) return true;
  }
  return false;
}

/**
 * HDFC Ergo per-state fallback region candidates. When the policy's resolved
 * region is a sub-city that HDFC files only TP rules for (e.g. "Surat" carries
 * SATP only), the Comp/SAOD rates live in a broader region label like
 * "Rest of Gujarat" or "AHMEDABAD" (under the "Pvt Car Robinhood" segment).
 *
 * Used in the cluster fallback to add HDFC-aware candidates so a Surat Comp
 * policy can pick up Robinhood Comp rules from "Rest of Gujarat" instead of
 * landing at "no rule".
 *
 * Keys are RTO state prefixes (uppercase). Order matters: most-specific-first
 * (state-level umbrella before country-level catch-all).
 */
const HDFC_STATE_FALLBACKS = {
  'GJ': ['Rest of Gujarat', 'AHMEDABAD', 'Ahemedabad', 'Ahemedabad, Surat', 'Gujarat'],
  'DL': ['Delhi NCR', 'NCR', 'Delhi'],
  'HR': ['Haryana', 'Delhi NCR', 'NCR'],
  'UP': ['Delhi NCR', 'NCR', 'Uttar Pradesh'],
  'MH': ['Maharashtra', 'Mumbai', 'Mumbai, Pune, Goa', 'Pune'],
  'WB': ['Rest of WB', 'Rest of West Bengal', 'Kolkata'],
  'TN': ['Rest of Tamil Nadu', 'Chennai'],
  'KA': ['Rest of Karnataka', 'Bangalore', 'Bengaluru'],
  'AP': ['ANDHRA PRADESH', 'Hyderabad'],
  'TS': ['Telangana', 'Hyderabad'],
  'TG': ['Telangana', 'Hyderabad'],
  'KL': ['Kerala'],
  'PB': ['Punjab', 'Chandigarh'],
  'CH': ['Chandigarh', 'Punjab'],
  'RJ': ['Rajasthan', 'Jaipur', 'Jodhpur'],
  'JK': ['J&K'],
  'JH': ['Jharkhand', 'Ranchi'],
  'OD': ['Odisha', 'Bhubaneshwar'],
  'OR': ['Odisha'],
  'BR': ['Bihar'],
  'UK': ['Uttarakhand', 'Dehradun'],
  'HP': ['Himachal Pradesh', 'Himachal pradesh'],
  'GA': ['Goa', 'GOA'],
  'MP': ['Madhya Pradesh', 'Indore'],
  'CG': ['Chhattisgarh'],
  'AS': ['Rest of Assam', 'KAMRUP', 'Nagaon'],
  // Union territories around Maharashtra/Gujarat
  'DD': ['DAMAN', 'DADRA & NAGAR HAVELI', 'Maharashtra', 'Mumbai, Pune, Goa'],
  'DN': ['DADRA & NAGAR HAVELI', 'DAMAN', 'Maharashtra'],
  'AN': ['ANDAMANS'],
};

/** Universal HDFC catch-all regions appended to every state-fallback list.
 *  HDFC's PCV grid stores per-state rules under region='All RTOs' with the
 *  state in `remarks` — the state-in-remarks check (re-enabled below for
 *  generic regions) narrows to the right one. */
const HDFC_GENERIC_FALLBACK_REGIONS = ['All RTOs', 'All'];

/** Generic HDFC region labels where remarks carries the actual state and
 *  must be checked. Specific regions (Mumbai, Surat, Delhi NCR…) have
 *  remarks as descriptive metadata only. */
const HDFC_GENERIC_REGIONS = new Set([
  'all', 'all rtos', 'all excluding declined rtos', 'pan india',
  'others', 'others 2', 'bad', 'good', 'bad locations', 'good locations',
  'rog location', 'rog bad locations', 'others, dd, dn',
]);
function isHdfcGenericRegion(region) {
  if (!region) return false;
  return HDFC_GENERIC_REGIONS.has(String(region).trim().toLowerCase());
}

/** Returns the HDFC state-fallback candidates for an RTO state prefix.
 *  Always appends the universal catch-all regions (`All RTOs`, `All`) so
 *  states without a per-state HDFC region (e.g. Jharkhand for PCV) still
 *  reach the rule via the state-in-remarks narrowing. */
function getHdfcStateFallbacks(stateKey) {
  const stateList = stateKey
    ? (HDFC_STATE_FALLBACKS[String(stateKey).toUpperCase()] || [])
    : [];
  return [...stateList, ...HDFC_GENERIC_FALLBACK_REGIONS];
}

/**
 * Cluster → candidate state-region labels used as rate_rules.region values.
 * Used as a fallback when the RTO mapping returns a cluster name (e.g. "NCR")
 * that does not exist as a region label in the rate card. Keys are normalized
 * upper-case cluster names.
 */
const CLUSTER_STATE_MAP = {
  // Keys are upper-cased cluster labels as they appear in rto_mappings.cluster.
  // Values are candidate rate_rules.region labels to try when region+cluster yields 0 rows.
  // Add entries here whenever an insurer is found whose rate_rules use state names
  // but whose RTO mapping uses cluster names.
  'NCR': ['DL', 'HP__HR', 'Bad_UP', 'UP'],
  'MMR': ['Mum', 'REST_OF_MH', 'MH'],
  'HR REF': ['HP__HR', 'HR'],
  'BLR': ['BLR', 'REST_OF_KA', 'KA'],
  'HYDERABAD': ['Hyderabad', 'AP_TS', 'TS', 'AP'],
  'PUNE': ['Pune', 'REST_OF_MH', 'MH'],
  'CHENNAI': ['TN', 'Chennai'],
  'KOLKATA': ['WB', 'Kolkata'],
  'AHMEDABAD': ['GJ_Good', 'REST_OF_GJ', 'GJ'],
  'UP OPEN': ['Good UP', 'Bad UP', 'UP', 'Bad_UP'],
  'GOOD GJ': ['GOOD GJ', 'Guj_Good', 'GJ_Good', 'GJ'],
  'GUJARAT': ['Guj_Good', 'GJ_Good', 'REST_OF_GJ', 'GUJARAT'],
  // Generic catch-all — Digit files non-metro regions under "ROM" (Rest of Market)
  // for Taxi/Comm segments and under state names for Bus. Try ROM first, then
  // specific state names that might be present in the card.
  'REST OF INDIA': ['ROM', 'Rest of India', 'ROM 1', 'ROM 2'],
  // J&K / Jammu — RTO mapping sometimes says "Rest of India" for far-flung RTOs.
  // Let state-level regions be picked up when it does exist in the card.
  'JAMMU': ['Jammu', 'J&K, Laddakh', 'J_K', 'Srinagar', 'ROM'],
  'SRINAGAR': ['Srinagar', 'Jammu', 'J&K, Laddakh', 'J_K', 'ROM'],
};

/**
 * RTO state prefix → preferred rate_rules.region labels for that state.
 * Used to narrow the cluster fallback list so (e.g.) an HR RTO in the NCR
 * cluster resolves to HP__HR rules, not Bad_UP or DL.
 */
const STATE_REGION_MAP = {
  'HR': ['HP__HR', 'HR'],
  'HP': ['HP__HR', 'HP'],
  'DL': ['DL'],
  'UP': ['Bad_UP', 'UP'],
  'UK': ['UK'],
  'MH': ['Mum', 'Pune', 'REST_OF_MH', 'MH'],
  'KA': ['BLR', 'REST_OF_KA', 'KA'],
  'TN': ['TN', 'Chennai'],
  'AP': ['AP_TS', 'Hyderabad', 'AP'],
  'TS': ['AP_TS', 'Hyderabad', 'TS'],
  'TG': ['AP_TS', 'Hyderabad', 'TS'],
  'GJ': ['GJ_Good', 'REST_OF_GJ', 'GJ'],
  'MP': ['MP__CG', 'MP'],
  'CG': ['MP__CG', 'CG'],
  'CT': ['MP__CG', 'CG'],
  'WB': ['WB'],
  'OD': ['Orissa', 'OD', 'OR'],
  'OR': ['Orissa', 'OR'],
  'PB': ['PB_CH', 'PB'],
  'CH': ['PB_CH', 'CH'],
  'RJ': ['RJ'],
  'JH': ['JH'],
  'BR': ['Bihar', 'BR'],
  'AS': ['Assam', 'NE', 'AS'],
  'JK': ['J_K', 'Jammu', 'Srinagar', 'J&K, Laddakh', 'JK'],
  'KL': ['KL'],
  'GA': ['Goa', 'GA'],
  'AN': ['Andaman', 'AN'],
};

/**
 * Universal Sompo: RTO state prefix → ordered list of the insurer's region
 * labels for that state. First entry is the primary (used to scope the
 * initial lookup); the rest are fallback candidates (cluster / city groups).
 * Border UTs map onto the parent state's combined region (DD/DN → GJ/DD).
 */
const US_STATE_REGION = {
  MH: ['MAHARASHTRA'],
  GJ: ['GUJARAT', 'GJ/DD'],
  DD: ['GJ/DD', 'GUJARAT'],
  DN: ['GJ/DD', 'GUJARAT'],
  DL: ['DELHI', 'DL-NCR', 'NCR'],
  HR: ['HARYANA', 'DL-NCR', 'NCR'],
  UP: ['UTTAR PRADESH', 'UP-1', 'UP-2', 'UP-3'],
  RJ: ['RAJASTHAN', 'RJ-1', 'RJ-2', 'RJ-3'],
  MP: ['MADHYA PRADESH', 'Ujjain, Indore, Bhopal', 'Rest of MP'],
  KA: ['KARNATAKA', 'Bangalore, Mysore, Mangalore', 'Rest of KA'],
  TN: ['TAMIL NADU'],
  TS: ['TELANGANA'],
  TG: ['TELANGANA'],
  AP: ['ANDHRA PRADESH'],
  KL: ['KERALA'],
  PB: ['PUNJAB'],
  CH: ['CHANDIGARH', 'PUNJAB'],
  WB: ['WEST BENGAL'],
  BR: ['BIHAR'],
  JH: ['JHARKHAND'],
  OD: ['ODISHA'],
  OR: ['ODISHA'],
  CG: ['CHHATTISGARH'],
  CT: ['CHHATTISGARH'],
  GA: ['GOA'],
  HP: ['HIMACHAL PRADESH'],
  UK: ['UTTARAKHAND'],
  UA: ['UTTARAKHAND'],
  JK: ['J&K/LA'],
  LA: ['J&K/LA'],
  AS: ['ASSAM'],
  SK: ['SIKKIM'],
  PY: ['PUDUCHERRY'],
};

function rtoStatePrefix(rtoCode) {
  if (!rtoCode) return '';
  const m = String(rtoCode).trim().toUpperCase().match(/^([A-Z]{2})/);
  return m ? m[1] : '';
}

/**
 * POST /lookup
 * Fetch policy details from Prarambh_UAT view, match rate rules, and calculate commission.
 */
router.post('/lookup', async (req, res, next) => {
  try {
    // Accept either policy_no or tracker_no (or a single `lookup_value` for the shared input).
    const raw = (req.body.lookup_value || req.body.policy_no || req.body.tracker_no || '').toString().trim();
    if (!raw) {
      return res.status(400).json({ success: false, error: 'Policy or Tracker number is required' });
    }

    const pool = await getPool();           // RateExtract DB (rate rules)
    const prarambhPool = await getPrarambhPool(); // Prarambh_Live DB (policy data)

    // Step 1: Fetch policy details from Prarambh_Live view.
    // Decide the primary column based on the input shape — tracker numbers
    // contain "/" (e.g. "MT/DIRSW/MH1/1909/FY25-26/1") while policy numbers are
    // purely alphanumeric. Running the wrong column first forces a full scan
    // on a table with millions of rows, which can take minutes.
    const looksLikeTracker = raw.includes('/');
    const primaryCol = looksLikeTracker ? 'TRACKER NO' : 'POLICY NO';
    const fallbackCol = looksLikeTracker ? 'POLICY NO' : 'TRACKER NO';

    async function queryBy(col, timeoutMs) {
      const req = prarambhPool.request();
      if (timeoutMs) req.timeout = timeoutMs;
      return req
        .input('lookupVal', sql.NVarChar, raw)
        .query(`SELECT * FROM vw_NewTempPrarambhExcelMotorDownload
                WHERE [${col}] = @lookupVal`);
    }

    let policyResult = await queryBy(primaryCol, looksLikeTracker ? 90000 : 30000);
    if (policyResult.recordset.length === 0) {
      policyResult = await queryBy(fallbackCol, 90000);
    }

    if (policyResult.recordset.length === 0) {
      return res.json({
        success: false,
        error: `No policy found for: ${raw}`,
      });
    }

    const policy = policyResult.recordset[0];

    // Step 2: Extract parameters from policy record
    const params = extractPolicyParams(policy);
    // State name surfaced from the source row — fed into the state/city
    // fallback below when RTO → cluster lookups all miss.
    params._stateName = policy['STATE NAME'] || policy.STATE || policy.StateName ||
                        policy['branch_state_name'] || null;

    // Tonnage fallback — when VehicalCategory text didn't yield a band,
    // try TRN_PrarambhMotorDetails.Tonnes (joined by PrarambhMainId).
    if ((params.tonnage == null || params.tonnageCoarse) && params.mainId) {
      try {
        const { fetchTonnage } = require('../services/prarambh-tonnage');
        const t = await fetchTonnage(prarambhPool, params.mainId);
        if (t != null) {
          params.tonnage = t;
          params.tonnageCoarse = false;
          // Precise GVW — collapse min/max so band matching keys off it.
          params.tonnageMin = t;
          params.tonnageMax = t;
        }
      } catch (e) {
        console.warn('[policy] tonnage fallback skipped:', e.message);
      }
    }

    // Fuel fallback — the Prarambh download view often ships a blank
    // [FUEL TYPE] even though TRN_PrarambhMotorDetails carries the fuel under
    // FUELTYPE / VEHICAL_FUELTYPE (e.g. a Hyundai Aura taxi stored as "CNG").
    // Without it the rate filter can't pick the right Diesel/CNG/Electric/
    // non-diesel taxi band and the policy drops to No-Rule. Mirror the bulk
    // enrichment chain (PR → TRN). Here only TRN is reachable per-policy.
    const usableFuel = (v) => {
      const s = String(v == null ? '' : v).trim();
      return (!s || /^(na|n\/a|none|null|other|others|unknown)$/i.test(s)) ? '' : s;
    };
    if (!usableFuel(params.fuelType) && params.mainId) {
      try {
        const { fetchRtoMap } = require('../services/prarambh-tonnage');
        const m = await fetchRtoMap(prarambhPool, [params.mainId]);
        const trn = m && m.get ? m.get(params.mainId) : null;
        const f = trn && usableFuel(trn.fuel);
        if (f) params.fuelType = f;
      } catch (e) {
        console.warn('[policy] fuel fallback skipped:', e.message);
      }
    }

    // Step 3: Map insurer name to config slug
    const insurerSlug = resolveInsurerSlug(params.insurerName);
    if (!insurerSlug) {
      return res.json({
        success: true,
        policy,
        params,
        error: `Could not map insurer "${params.insurerName}" to a configured insurer. Available: digit, chola, bajaj_allianz`,
        rules: [],
        calculation: null,
      });
    }

    // Step 4: Resolve RTO to region
    let resolvedRegion = null;
    let rtoInfo = null;
    if (params.rtoCode) {
      rtoInfo = await resolveRTO(pool, insurerSlug, rtoProductFor(params), params.rtoCode);
      if (rtoInfo) {
        resolvedRegion = rtoInfo.region;
      }
    }
    // City-region carriers: when no RTO is available (new vehicle, blank reg,
    // etc.), use the policy's booking location as the primary region so the
    // initial lookup is narrowed to the right city instead of returning rules
    // from every region nationwide. ICICI / HDFC Ergo store rates by city
    // (MUMBAI / Delhi NCR / etc.) so booking-branch is a strong proxy.
    if (!resolvedRegion && (insurerSlug === 'icici_lombard' || insurerSlug === 'hdfc_ergo')) {
      const bookedLoc = String(
        policy.BusinessBookedLocation || policy['BUSINESS BOOKED LOCATION'] ||
        policy.BooKedLocation || ''
      ).trim();
      if (bookedLoc) resolvedRegion = bookedLoc;
    }
    // ICICI region-name normalization. The RTO map / booking location carry
    // labels like GURGAON / DELHI / Jammu / Motor Kolkata that don't appear
    // in ICICI's rate card. Translate to the card's actual region names so
    // the initial SQL lookup hits.
    if (insurerSlug === 'icici_lombard' && resolvedRegion) {
      resolvedRegion = aliasIciciRegion(resolvedRegion);
    }
    // HDFC Ergo region-name normalization (see HDFC_REGION_ALIASES). Same
    // idea: MEHSANA / GURGAON / JANAK PURI etc. don't exist in HDFC's card,
    // so map them to "Rest of Gujarat" / "Delhi NCR" before the lookup.
    if (insurerSlug === 'hdfc_ergo' && resolvedRegion) {
      resolvedRegion = aliasHdfcRegion(resolvedRegion);
    }
    // Universal Sompo region resolution: US files rates under the full
    // UPPERCASE state name plus cluster regions (GJ/DD, DL-NCR, UP-1/2/3,
    // RJ-1/2/3) and a few city groups. When the RTO map didn't resolve a
    // region, derive the primary region from the RTO-state so the initial
    // lookup is scoped — otherwise an empty region returns ALL-state rules
    // and the dedup can pick a wrong one (e.g. a Maharashtra GCV matching
    // J&K). The first entry is the primary; the rest feed the fallback
    // (see usCandidates) when the primary misses a segment.
    if (insurerSlug === 'universal_sompo' && !resolvedRegion && !(rtoInfo && rtoInfo.cluster)) {
      const fam = US_STATE_REGION[rtoStatePrefix(params.rtoCode)];
      if (fam && fam.length) resolvedRegion = fam[0];
    }
    // Shriram region resolution: Shriram's grid stores `region` as the full
    // UPPERCASE state name (e.g. "MAHARASHTRA", "ODISHA"), with national rows
    // under a NULL/'' region ("PAN INDIA"). Shriram ships no RTO→region map,
    // so resolvedRegion is null and the unfiltered (empty-region) lookup
    // returns rules from EVERY state — the scorer then lands on an arbitrary
    // state's rule (e.g. a Maharashtra GCV matching an ODISHA rate). Seed the
    // region from the RTO-state's full name so the lookup is state-scoped; the
    // include_null_region flag (below) keeps the national PAN-INDIA rows in play.
    if (insurerSlug === 'shriram' && !resolvedRegion) {
      const fullState = STATE_PREFIX_FULL[rtoStatePrefix(params.rtoCode)];
      if (fullState) resolvedRegion = fullState;
    }

    // Step 5: Lookup matching rate rules
    // Don't filter by segment/make in SQL — we'll smart-match after.
    // Product resolution: the RTO mapping carries the insurer-specific product code
    // (e.g. '4W' for Digit cars). Prefer it over the text-derived vehicleType.
    // Product resolution priority:
    //   1. The policy's own mapped vehicle type (MISC, GCV, PCV, CAR, TW, TW_EV)
    //      — this is the most specific.
    //   2. RTO mapping's product — often a generic "CV" that groups all commercial
    //      vehicles; used only when the policy's own type is unknown.
    const SPECIFIC_VEHICLE_TYPES = new Set(['MISC', 'GCV', 'PCV', 'CAR', 'TW', 'TW_EV', '4W', '2W', 'PC']);
    const policyType = String(params.vehicleType || '').toUpperCase();
    const resolvedProduct = SPECIFIC_VEHICLE_TYPES.has(policyType)
      ? params.vehicleType
      : ((rtoInfo && rtoInfo.product) || params.vehicleType);
    const resolvedCluster = (rtoInfo && rtoInfo.cluster) || '';
    // Product aliases — the same vehicle class may be catalogued under multiple
    // product codes across sheets of the same insurer (e.g. Digit stores bundled
    // 4W rates under product='4W' and matrix Comp/SAOD rates under product='CAR').
    // Query all aliases at once so rate rules from any sheet are considered.
    const PRODUCT_ALIASES = {
      '4W':  ['4W', 'CAR', 'PC', 'PVT.CAR'],
      'CAR': ['CAR', '4W', 'PC', 'PVT.CAR'],
      'PC':  ['PC', '4W', 'CAR'],
      'TW':  ['TW', '2W', 'TW_EV'],
      'GCV': ['GCV', 'CV'],
      'PCV': ['PCV', 'CV'],
      // MISC also includes 'GCV' because Chola stores tractor rates under
      // product=GCV with segment "1_TRAC[NEW]" / "1_TRAC[RENEWAL]" — they
      // belong to MISC product family by vehicle classification but live in
      // the GCV rate grid. Without GCV here, MISC-Tractor policies see only
      // EXCAVATOR/HARVESTOR rules and drop them all.
      'MISC': ['MISC', 'CV', 'GCV'],
      // 'CV' is the generic code Digit uses for commercial vehicles in rto_mappings.
      // Rate rules may be split across GCV / PCV / MISC / CV, so query all of them.
      'CV':  ['CV', 'GCV', 'PCV', 'MISC'],
    };
    const productList = PRODUCT_ALIASES[String(resolvedProduct).toUpperCase()] || [resolvedProduct];

    // For TW the fuel distinction is encoded in the segment text (SC/EV, MC/EV)
    // rather than a dedicated column — filtering by rr.fuel_type at SQL level
    // would drop "SC/EV Electric" rules from petrol scooters. Let the post-filter
    // decide via segment tokens instead.
    const productIsTw = String(resolvedProduct).toUpperCase().includes('TW') ||
                        String(resolvedProduct).toUpperCase().includes('2W');
    const lookupParams = {
      insurer: insurerSlug,
      product: productList,
      region: resolvedRegion || '',
      cluster: resolvedCluster,
      vehicle_age: params.vehicleAge,
      fuel_type: productIsTw ? '' : (params.fuelType || ''),
      ins_product: params.insProduct || '',
      // Shriram: state-name region filter must still surface national
      // (NULL/'' region = "PAN INDIA") rows.
      include_null_region: insurerSlug === 'shriram',
    };

    let rules = await lookupRates(pool, lookupParams);

    // Step 5a: Post-filter initial results first
    let rulesBeforeSmartFilter = rules.length;
    // Optional trace — populated only when the request asks for it; surfaced
    // back in the response so the caller can see exactly why each SQL rule
    // survived or dropped during the smart filter.
    const wantsTrace = !!(req.body && req.body.trace);
    const traceBuf = wantsTrace ? [] : null;
    if (rules.length > 0) {
      rules = filterRulesByPolicy(rules, params, traceBuf);
    }

    // Step 5b: Cluster fallback — fire when either the SQL lookup or the
    // post-filter ended with 0 rules. Retry against candidate rate-rule regions
    // in priority order and stop at the first one that yields any rules after
    // post-filtering. The RTO mapping's cluster is authoritative.
    let clusterFallback = null;
    if (rules.length === 0) {
      const key = (resolvedCluster || resolvedRegion || '').trim().toUpperCase();
      const clusterCandidates = CLUSTER_STATE_MAP[key] || [];
      const stateKey = rtoStatePrefix(params.rtoCode);
      const stateCandidates = STATE_REGION_MAP[stateKey] || [];
      // Tier candidates (Royal-style "Key Cities" / "Other Cities" / "Rest
      // of State"); the smart filter narrows by state via rule.remarks.
      const tierCandidates = inferLocationTiers(resolvedCluster || resolvedRegion, params._stateName, insurerSlug);
      // HDFC Ergo: when the resolved sub-city has only TP rules (e.g. Surat
      // ships SATP only; Comp lives under "Rest of Gujarat"/"AHMEDABAD"
      // with the "Pvt Car Robinhood" segment), add HDFC's state-level
      // umbrella regions so the Comp/SAOD lookup hits. Pull from both
      // the alias map (keyed by resolved region) and the state-fallback
      // map (keyed by RTO state prefix) — same as ICICI handling below.
      const hdfcCandidates = (insurerSlug === 'hdfc_ergo')
        ? [
            ...(HDFC_REGION_ALIASES[key] || []),
            ...getHdfcStateFallbacks(stateKey),
          ]
        : [];
      // ICICI Lombard: region naming differs by product (TW uses
      // "Ahmedabad & Gandhinagar", GCV/PCV/MISC uses "AHMEDABAD & GANDHINAGAR"
      // / "JAMMUANDKASHMIR" / "UP-EAST"). Add all the state's variants so
      // the right one hits whichever product this policy is.
      // Pull from BOTH the alias map (keyed by resolved region — needed when
      // RTO is missing and we primed from BookedLocation) and the state-
      // fallback map (keyed by RTO state prefix).
      const iciciCandidates = (insurerSlug === 'icici_lombard')
        ? [
            ...(ICICI_REGION_ALIASES[key] || []),
            ...getIciciStateFallbacks(stateKey),
          ]
        : [];
      // Reliance: rate cards use city-named regions (LUCKNOW, MUMBAI, AHMEDABAD,
      // …) plus state-prefix clusters (UP1, UP2, MH1, …). Source `City Name`
      // (e.g. "Lucknow") matches Reliance's "LUCKNOW" region after uppercasing.
      const relianceCandidates = (insurerSlug === 'reliance')
        ? (() => {
            const out = [];
            const cityRaw = String(params.city || params._cityName || '').trim();
            if (cityRaw) out.push(cityRaw.toUpperCase());
            // Reliance UP RTOs split into UP1 (West/NCR adjacent) and UP2
            // (East/rest); the cluster is fuzzy from RTO alone — add both as
            // fallback after the city-specific candidate.
            if (stateKey === 'UP') out.push('UP1', 'UP2');
            if (stateKey === 'MH') out.push('MH1', 'MH2');
            return out;
          })()
        : [];
      // Bajaj: region naming varies wildly per product sheet. TW grids file
      // Delhi under "DELHI", "DELHI- NCR", and "DELHI&NCR (Including Gurgaon
      // and Faridabad)" — the bare cluster label "DELHI&NCR" we resolve
      // from rto_mappings doesn't appear in the TW Bike grid. Add the full
      // Delhi family plus the city-named sub-RTO so the fallback hits.
      const bajajCandidates = (insurerSlug === 'bajaj_allianz')
        ? (() => {
            const out = [];
            if (stateKey === 'DL') {
              out.push(
                'DELHI&NCR (Including Gurgaon and Faridabad)',
                'DELHI- NCR',
                'DELHI',
                'RTO-DL',
                'New Delhi'
              );
            }
            if (stateKey === 'HR') out.push('Haryana', 'HARYANA (Excluding Gurgaon and Faridabad)', 'Gurgaon', 'Faridabad');
            // Bajaj GCV ships SATP rates under compound region labels that
            // bundle border UTs into the state group (Gujarat + Daman/Diu/DNH,
            // Tamil Nadu + Lakshadweep, J&K + Ladakh, Assam + Sikkim + NE).
            // The state-name region carries only COMP — without these
            // compound aliases a TP-only policy in Gujarat lands no-rule.
            if (stateKey === 'GJ' || stateKey === 'DD' || stateKey === 'DN') {
              out.push('GUJARAT, Daman & Diu, Dadra & Nagar Haveli', 'GUJARAT');
            }
            if (stateKey === 'TN') out.push('TAMIL NADU, Lakshadweep', 'TAMIL NADU');
            if (stateKey === 'JK' || stateKey === 'LA') out.push('JAMMU & KASHMIR, Ladakh', 'JAMMU & KASHMIR');
            if (stateKey === 'AS') out.push('ASSAM, SIKKIM, 6 OTHER NORTH EASTERN STATES', 'ASSAM');
            const cityRaw = String(params.city || params._cityName || '').trim();
            if (cityRaw) out.push(cityRaw);
            return out;
          })()
        : [];
      // Zuno (Robinhood): rate card uses catch-all regions "All doable
      // RTO's" / "All doable RTO'S" and a "Pan India (doable RTOs)" bucket
      // that holds the global NCB=0 / discount-override rates. These aren't
      // token-matchable from the bare "Pan India" tier candidate, so add
      // them explicitly.
      const zunoCandidates = (insurerSlug === 'zuno')
        ? ["All doable RTO's", "All doable RTO'S", 'Pan India (doable RTOs)']
        : [];
      // TATA: the standard Pvt Car Package/SAOD rates (PCI sheet) are
      // national, emitted under the "PAN INDIA" region. Add it so a Pvt Car
      // policy whose city region only has Extended-Warranty (now dropped)
      // or no Package rule falls through to the national PCI rate.
      const tataCandidates = (insurerSlug === 'tata_aig')
        ? ['PAN INDIA']
        : [];
      // Universal Sompo: state region + cluster / city-group variants, so a
      // policy whose primary state region lacks the segment falls through to
      // the cluster regions (DL-NCR, UP-1/2/3, RJ-1/2/3, GJ/DD, city groups).
      const usCandidates = (insurerSlug === 'universal_sompo')
        ? (US_STATE_REGION[stateKey] || [])
        : [];
      // Zuno NCB=0 override: per the rate card, a zero-NCB Pvt Car takes the
      // Pan India "NCB = 0 → 15%" rate. BUT this is an OD/Comp rate — NCB
      // only discounts the OD premium, never the statutory TP. So the
      // override applies ONLY to OD-bearing products (Comp / SAOD). A pure
      // TP policy keeps its SATP rate (e.g. 18%) regardless of NCB. The
      // fallback loop breaks at the first region match, so for Comp/SAOD
      // zero-NCB we try the Pan India override FIRST; for TP we skip it.
      const policyNcbZeroLocal = !((params.ncbPct || 0) > 0);
      const ipLocal = String(params.insProduct || '').toUpperCase();
      const policyIsTpLocal = ipLocal === 'TP';
      const zunoNcbZeroFirst = (insurerSlug === 'zuno' && policyNcbZeroLocal && !policyIsTpLocal)
        ? ['Pan India (doable RTOs)']
        : [];
      // United India Insurance: rate cards file regions as either the full
      // state name ("Rajasthan", "Uttar Pradesh") OR the specific RTO code
      // ("RJ23", "UP44", "HR55"). The bare RTO state prefix ("RJ", "UP")
      // doesn't exist as a region label. Add the full state name plus the
      // policy's exact RTO code so the per-RTO + state-name buckets are
      // covered.
      const uiiCandidates = (insurerSlug === 'united_india_insurance')
        ? (() => {
            const out = [];
            const rto = String(params.rtoCode || '').trim().toUpperCase();
            if (rto) out.push(rto);
            const fullState = STATE_PREFIX_FULL[stateKey];
            if (fullState) out.push(fullState);
            return out;
          })()
        : [];
      // SBI General: cluster-coded regions like "UP - AKLGV", "MH - Rest",
      // "PB - AJHLG". Many segments (PCV 3W, School Bus) aren't published
      // in every cluster — fall through to the state's "Rest" clusters and
      // the bare state-name region for the same product.
      const sbiCandidates = (insurerSlug === 'sbi_general')
        ? (() => {
            const out = [];
            const STATE_FAMILIES = {
              UP: ['UP - AKLGV', 'UP - Rest 1', 'UP - Rest 2', 'UTTAR PRADESH', 'UTTAR PRADESH (Eastern)'],
              MH: ['MH - M', 'MH - Rest', 'Mumbai', 'Navi Mumbai', 'Pune', 'RO Maharashtra', 'MAHARASHTRA'],
              GJ: ['GJ - A', 'GJ - S', 'GJ - V', 'GJ - Rest', 'Ahmedabad, Baroda & Surat', 'GUJARAT'],
              PB: ['PB - AJHLG', 'PB - Rest', 'PUNJAB / CHANDIGARH', 'PUNJAB'],
              DL: ['DELHI', 'DL - NCR'],
              KA: ['KA - B', 'Bangalore', 'KARNATAKA'],
              TN: ['TN - C', 'TN - CO', 'TAMIL NADU- Chennai', 'TAMIL NADU- Chennai II', 'TAMIL NADU'],
              TS: ['TS - H', 'TS - Rest 1', 'TS - Rest 2', 'TELANGANA'],
              AP: ['AP - VVK', 'AP - Rest', 'ANDHRA PRADESH'],
              WB: ['WB - K', 'WB - Rest 1', 'WB - Rest 2', 'Kolkata', 'Rest of West Bengal'],
              CH: ['CH - R', 'CH - Rest'],
              CG: ['CG - Tricity'],
              HP: ['HP', 'HIMACHAL PRADESH'],
              JK: ['JK', 'JAMMU AND KASHMIR'],
              JH: ['JH', 'JHARKHAND'],
              BR: ['BR', 'BIHAR'],
              OD: ['ODISHA'],
              RJ: ['RAJASTHAN'],
              GA: ['GA', 'GOA'],
              DD: ['Daman & Diu', 'DADRA AND NAGAR HAVELI'],
              DN: ['DADRA AND NAGAR HAVELI'],
            };
            const fam = STATE_FAMILIES[stateKey] || [];
            return fam;
          })()
        : [];
      // Merge: cluster candidates first (RTO mapping authoritative), then
      // state-prefix candidates, then carrier-specific umbrella, then tier candidates.
      const seen = new Set();
      const candidates = [
        ...zunoNcbZeroFirst,
        ...clusterCandidates, ...stateCandidates,
        ...hdfcCandidates, ...iciciCandidates, ...relianceCandidates,
        ...bajajCandidates, ...sbiCandidates, ...uiiCandidates,
        ...zunoCandidates, ...usCandidates, ...tataCandidates,
        ...tierCandidates,
      ].filter(r => {
        if (seen.has(r)) return false; seen.add(r); return true;
      });
      const attempts = [];
      for (const r of candidates) {
        // Use token-mode region matching inside the fallback so a candidate
        // like "Mumbai" also matches compound rows like "Mumbai/GA/Pune/Central MH".
        let attemptRules = await lookupRates(pool, {
          ...lookupParams, region: r, cluster: '', region_list: null,
          region_match_mode: 'token',
        });
        // SAOD-as-Comp inside the fallback (Royal Sundaram doesn't carry a
        // dedicated SAOD rate_type — reuses Comp). Mirrors the top-of-bulk
        // SAOD-as-Comp 2-pass.
        if (attemptRules.length === 0 && lookupParams.ins_product === 'SAOD') {
          attemptRules = await lookupRates(pool, {
            ...lookupParams, ins_product: 'Comp', region: r, cluster: '',
            region_list: null, region_match_mode: 'token',
          });
        }
        // TP-as-Comp: several insurers quote a single Comp rate that
        // covers both OD and TP (UII for GCV/TW, Kotak for TW, IFFCO
        // Tokio). When the TP lookup returns zero rules, retry with
        // ins_product='Comp' so the flat-rate Comp rules surface. The
        // smart filter retains them via the OD-&-TP remarks heuristic
        // / TW family guard.
        if (attemptRules.length === 0
            && lookupParams.ins_product === 'TP') {
          attemptRules = await lookupRates(pool, {
            ...lookupParams, ins_product: 'Comp', region: r, cluster: '',
            region_list: null, region_match_mode: 'token',
          });
        }
        const afterFilter = attemptRules.length > 0 ? filterRulesByPolicy(attemptRules, params) : [];
        attempts.push({ region: r, sql_count: attemptRules.length, filtered_count: afterFilter.length });
        if (afterFilter.length > 0) {
          rules = afterFilter;
          rulesBeforeSmartFilter = attemptRules.length;
          break;
        }
      }
      if (candidates.length > 0) {
        clusterFallback = {
          cluster: resolvedCluster || resolvedRegion,
          rto_state: stateKey || null,
          priority_order: candidates,
          attempts,
          picked_region: rules.length > 0 ? attempts[attempts.length - 1].region : null,
          matched: rules.length,
          tried_regions: candidates,
        };
      }
    }

    // Step 5b.2: State/city fallback — when RTO → cluster/state lookups
    // all miss, try the policy's StateName / city directly against rate-
    // rule regions (token mode so compound regions like "Mumbai/GA/..."
    // still match). Mirrors the fallback in routes/bulk.js so single-policy
    // and bulk results stay consistent.
    let stateCityFallback = null;
    if (rules.length === 0) {
      const stateName = String(params._stateName || '').trim();
      const cityName  = String(
        policy['CLIENT CITY NAME'] || policy['VEHICLE CITY']  ||
        policy.client_city_name    || policy.VEHICLE_CITY    || ''
      ).trim();
      const candidates = [];
      if (cityName)  candidates.push(cityName);
      if (stateName) candidates.push(stateName);
      const attempts = [];
      for (const r of candidates) {
        const attemptRules = await lookupRates(pool, {
          ...lookupParams, region: r, cluster: '', region_list: null,
          region_match_mode: 'token',
        });
        const afterFilter = attemptRules.length > 0 ? filterRulesByPolicy(attemptRules, params) : [];
        attempts.push({ region: r, sql_count: attemptRules.length, filtered_count: afterFilter.length });
        if (afterFilter.length > 0) {
          rules = afterFilter;
          rulesBeforeSmartFilter = attemptRules.length;
          break;
        }
      }
      if (candidates.length > 0) {
        stateCityFallback = {
          state: stateName || null,
          city:  cityName  || null,
          attempts,
          picked: rules.length > 0 ? attempts.find(a => a.filtered_count > 0).region : null,
        };
      }
    }

    // Step 5b.3: Go Digit last-resort — when RTO / cluster / state / city
    // all miss, fall back to "Ahmedabad". Digit's rate cards lean on
    // city-based regions and Ahmedabad covers most segments as a catch-all.
    if (rules.length === 0 && insurerSlug === 'go_digit') {
      const attemptRules = await lookupRates(pool, {
        ...lookupParams, region: 'Ahmedabad', cluster: '', region_list: null,
        region_match_mode: 'token',
      });
      const afterFilter = attemptRules.length > 0 ? filterRulesByPolicy(attemptRules, params) : [];
      if (afterFilter.length > 0) {
        rules = afterFilter;
        rulesBeforeSmartFilter = attemptRules.length;
        resolvedRegion = 'Ahmedabad';
      }
    }

    // Step 5b.4: ICICI Lombard / HDFC Ergo last-resort — when RTO / cluster
    // / state / city all miss, fall back to the policy's booking location.
    // Both carriers bucket many rules by booking-branch city (e.g. "JANAK
    // PURI", "MUMBAI ANDHERI", "Delhi NCR") so the booked location hits
    // where the RTO-derived region doesn't.
    if (rules.length === 0 && (insurerSlug === 'icici_lombard' || insurerSlug === 'hdfc_ergo')) {
      let bookedLoc = String(
        policy.BusinessBookedLocation || policy['BUSINESS BOOKED LOCATION'] ||
        policy.BooKedLocation || ''
      ).trim();
      if (insurerSlug === 'icici_lombard') bookedLoc = aliasIciciRegion(bookedLoc);
      else if (insurerSlug === 'hdfc_ergo') bookedLoc = aliasHdfcRegion(bookedLoc);
      if (bookedLoc) {
        const attemptRules = await lookupRates(pool, {
          ...lookupParams, region: bookedLoc, cluster: '', region_list: null,
          region_match_mode: 'token',
        });
        const afterFilter = attemptRules.length > 0 ? filterRulesByPolicy(attemptRules, params) : [];
        if (afterFilter.length > 0) {
          rules = afterFilter;
          rulesBeforeSmartFilter = attemptRules.length;
          resolvedRegion = bookedLoc;
        }
      }
    }

    // Step 5b.5: Shriram all-region last resort. Shriram files some products
    // (GCV, MISC, and some PCV/CAR) by internal ZONE labels ("Zone 1"...) that
    // a state-name region filter can't reach yet (zone resolution needs the
    // workbook's Zone reference sheet). When the state-scoped + national lookup
    // and every fallback above still find nothing, drop the region filter so
    // the scorer can still surface a usable rule — exactly the pre-state-fix
    // behaviour, so this can never do worse than baseline for those products.
    if (rules.length === 0 && insurerSlug === 'shriram') {
      const attemptRules = await lookupRates(pool, {
        ...lookupParams, region: '', cluster: '', region_list: null,
        include_null_region: false,
      });
      const afterFilter = attemptRules.length > 0 ? filterRulesByPolicy(attemptRules, params) : [];
      if (afterFilter.length > 0) {
        rules = afterFilter;
        rulesBeforeSmartFilter = attemptRules.length;
      }
    }

    // Step 5c: Diagnostics — if we ended with 0 rules, probe each filter to show
    // where the elimination happened, so the user can see exactly what dropped it.
    let diagnostics = null;
    if (rules.length === 0) {
      diagnostics = await buildDropDiagnostics(pool, {
        lookupParams,
        fallbackRegions: clusterFallback ? clusterFallback.tried_regions : null,
        rulesBeforeSmartFilter,
        policyParams: params,
      });
    }

    // Step 6: Calculate payout
    const premiums = {
      od_premium: params.odPremium || 0,
      tp_premium: params.tpPremium || 0,
      addon_premium: params.addonPremium || 0,
      net_premium: params.netPremium || 0,
    };

    const calculation = calculatePayout(rules, premiums, {
      vehicle_age: params.vehicleAge,
      discount_pct: params.discountPct,
      vehicle_type: params.vehicleType, // GCV/PCV/MISC → net-premium base
      ins_product: params.insProduct,   // CAR/TW: Comp|SAOD → OD+Addon, TP → TP
    });

    res.json({
      success: true,
      policy,
      params: {
        ...params,
        insurer_slug: insurerSlug,
        resolved_region: resolvedRegion,
        resolved_cluster: resolvedCluster || null,
      },
      rto_info: rtoInfo,
      rules_count: rules.length,
      rules: rules.slice(0, 50), // Limit to 50 for display
      cluster_fallback: clusterFallback,
      state_city_fallback: stateCityFallback,
      diagnostics,
      calculation,
      filter_trace: traceBuf,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Extract relevant parameters from the policy record.
 * Column names come from vw_NewTempPrarambhExcelMotorDownload.
 */
function extractPolicyParams(policy) {
  // Normalize column access — the view may have varying case/spacing
  const get = (key) => {
    // Try exact match first
    if (policy[key] !== undefined) return policy[key];
    // Try case-insensitive match
    const lowerKey = key.toLowerCase();
    for (const k of Object.keys(policy)) {
      if (k.toLowerCase() === lowerKey) return policy[k];
    }
    return null;
  };

  const insurerName = get('INSURER NAME') || get('ShortName') || get('INSURER') || get('Insurer') || '';
  const policyType = get('PRODUCT TYPE') || get('POLICY TYPE') || get('PolicyType') || '';
  const vehicleClass = get('MOTOR VEHICAL TYPE') || get('VEHICAL TYPE') || get('VEHICLE CLASS') || '';
  const vehicleType = get('MOTOR VEHICAL TYPE') || get('VEHICAL TYPE') || get('VEHICLE TYPE') || '';
  // Sub-category discriminator: "TW - Scooty" / "TW - Motorcycle" / "Car" / "Taxi" etc.
  // This is more specific than vehicleClass (which is often just "Two Wheeler").
  const vehicalCategoryRaw = (get('VehicalCategory') || get('VEHICLE CATEGORY') || get('VEHICAL CATEGORY') || '').toString().trim();
  const make = get('VEHICAL MAKE') || get('MAKE') || get('Make') || '';
  const model = get('VEHICAL MODEL') || get('MODEL') || get('Model') || '';
  const fuelType = get('FUEL TYPE') || get('FuelType') || '';
  const rtoCode = get('Code') || get('RTO') || get('RTO CODE') || '';
  // RTO fallback from the tracker number: operator trackers encode the RTO
  // as the 3rd slash-segment (e.g. "MT/DIRSW/MH36/1785/FY26-27/1" → "MH36").
  // Used when the RTO_Code / registration columns are blank (common for
  // direct-broker rows). Only accept a value that looks like an RTO code.
  let rtoFromTracker = '';
  {
    const trk = (get('TRACKER NO') || get('TRACKERNO') || get('Trackerno') ||
                 get('PTrackerno') || get('TRACKER') || '').toString().trim();
    if (trk) {
      const seg = (trk.split('/')[2] || '').trim().toUpperCase();
      // Accept the segment as an RTO only if it both LOOKS like one and its
      // 2-letter prefix is a REAL Indian state code. Some operators (e.g.
      // go_digit) put an internal branch grouping in this slot — "PJ3" — which
      // matches the shape but isn't a state ("PJ" ≠ Punjab "PB"; those PJ3
      // trackers actually span PB/AS/JK/DL/MH by registration). Treating it as
      // an RTO fabricates a wrong region for new-vehicle rows that have no
      // registration yet. Validating against STATE_PREFIX_FULL rejects "PJ3"
      // (falls back to a blank RTO) while keeping genuine "MH36"/"PB3".
      if (/^[A-Z]{2}\d{1,2}$/.test(seg) && STATE_PREFIX_FULL[seg.slice(0, 2)]) {
        rtoFromTracker = seg;
      }
    }
  }
  const segment = get('SEGMENT') || get('Segment') || '';
  const cc = get('CC') || '';
  const registrationDate = get('DATE OF REGISTRATION') || get('REGISTRATION DATE') || '';
  const vehicleSubModel = get('VEHICAL SUBMODAL') || '';
  const vehicleRegNo = (get('VEHICLE REGISTRATION NO') || get('VEHICLE REG NO') || get('VEHICLE NO') || get('REGISTRATION NO') || get('REG NO') || get('REGN NO') || get('VEHICLE REGISTRATION NUMBER') || '').toString().trim();

  // Seating capacity
  const seatingRaw = get('SEATING CAPACITY') || get('SEATING') || get('NO OF SEATS') || get('SEATS');
  const seatingCapacity = seatingRaw != null && seatingRaw !== '' && !isNaN(parseInt(seatingRaw))
    ? parseInt(seatingRaw, 10) : null;

  // Gross weight / tonnage (in KG typically; convert to tonnes if it looks like KG).
  // Bulk uses tmp_PrarambhData.Tonnes; single policy lookup falls back to
  // TRN_PrarambhMotorDetails.Tonnes (via the async helper in routes).
  const weightRaw = get('GROSS VEHICLE WEIGHT') || get('GVW') || get('TONNAGE') ||
                    get('UNLADEN WEIGHT') || get('GROSS WEIGHT') ||
                    // tmp_PrarambhData column (bulk path) and TRN_PrarambhMotorDetails (single).
                    get('Tonnes') || get('TONNES') || get('GROSS_VEHICLE_WEIGHT');
  let tonnage = null;
  let tonnageMin = null;
  let tonnageMax = null;
  // True when `tonnage` is only a coarse stand-in derived from an "Upto X"
  // category band (the upper bound), NOT a real GVW. A precise GVW from the
  // TRN fallback should override it (e.g. "Upto 2.5Tn" → 2.5, but the actual
  // 1.6T belongs in the "<= 2" band, not "2-2.5").
  let tonnageCoarse = false;
  if (weightRaw != null && weightRaw !== '' && !isNaN(parseFloat(weightRaw))) {
    const w = parseFloat(weightRaw);
    // If >= 1000 assume KG and convert to tonnes; else treat as tonnes already
    tonnage = w >= 1000 ? +(w / 1000).toFixed(3) : w;
  }

  // Fallback — parse tonnage range from VehicalCategory text.
  //
  // Covers the variants seen in Prarambh / rate cards:
  //   "GCV - 4W 2.5-3.5Tn"   → min 2.5, max 3.5 (ASCII hyphen)
  //   "GCV - 4W 20–40T"      → min 20,  max 40  (en-dash U+2013)
  //   "GCV - 4W 12 to 20Tn"  → min 12,  max 20  (the word "to")
  //   "GCV - 4W upto 2.5Tn"  → max 2.5
  //   "GCV - 4W 40Tn+"       → min 40          (with or without "n")
  //   "GCV - 4W 44T+"        → min 44
  //
  // The "Tn" suffix is common in Prarambh's VehicalCategory labels while rate
  // cards use just "T" — the `Tn?` alternation accepts either.
  const cat = (vehicalCategoryRaw || '').replace(/\u2013|\u2014/g, '-'); // normalize en/em-dash
  if (tonnage == null && cat) {
    let m;
    // Range: "X - Y Tn" or "X to Y Tn"
    if ((m = cat.match(/(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)\s*Tn?\b/i))) {
      tonnageMin = parseFloat(m[1]);
      tonnageMax = parseFloat(m[2]);
      tonnage = (tonnageMin + tonnageMax) / 2;  // midpoint estimate
      tonnageCoarse = true;        // precise GVW (TRN) should refine the band
    } else if ((m = cat.match(/upto\s*(\d+(?:\.\d+)?)\s*Tn?\b/i))) {
      tonnageMin = 0;
      tonnageMax = parseFloat(m[1]);
      tonnage = tonnageMax;        // coarse stand-in (upper bound)
      tonnageCoarse = true;        // let a precise GVW override this
    } else if ((m = cat.match(/(\d+(?:\.\d+)?)\s*Tn?\s*\+/i))) {
      tonnageMin = parseFloat(m[1]);
      tonnage = tonnageMin;        // coarse stand-in (lower bound of open band)
      tonnageCoarse = true;        // precise GVW should refine the band
    }
  }

  // Carrier / body type (Dumper, Tanker, Trailer, etc.)
  const carrierType = (get('CARRIER TYPE') || get('BODY TYPE') || get('BODYTYPE') || '').toString().trim();

  // Business type — NEW / ROLLOVER / RENEWAL
  const businessTypeRaw = (get('REPORTED BUSINESS TYPE') || get('BUSINESS TYPE') || get('POLICY NATURE') || get('BUSINESSTYPE') || '').toString().trim().toUpperCase();
  let businessType = '';
  if (businessTypeRaw) {
    if (/ROLL[\s-]*OVER/.test(businessTypeRaw)) businessType = 'Rollover';
    else if (/RENEW/.test(businessTypeRaw)) businessType = 'Renewal';
    else if (/NEW/.test(businessTypeRaw)) businessType = 'New';
    else businessType = businessTypeRaw;
  }

  // IDV / sum insured
  const idvRaw = get('VEHICLE IDV') || get('IDV') || get('SUM INSURED') || get('SUMINSURED');
  const idv = idvRaw != null && idvRaw !== '' && !isNaN(parseFloat(idvRaw)) ? parseFloat(idvRaw) : null;

  // High-end flag — treat IDV >= 30L as high-end fallback (no better field available)
  const isHighEnd = idv != null ? idv >= 3000000 : false;

  // Premium fields
  const odPremium = parseFloat(get('MOTOR NET OD PREMIUM') || get('BASE OD PREMIUM') || get('NET OD PREMIUM') || get('OD PREMIUM') || 0) || 0;
  let tpPremium = parseFloat(get('LIABILITY PREMIUM') || get('TP PREMIUM') || 0) || 0;
  const netPremium = parseFloat(get('PREMIUM WITHOUT GST') || get('NET PREMIUM') || 0) || 0;
  const addonPremium = parseFloat(get('ADD ON PREMIUM') || get('ADDON PREMIUM') || 0) || 0;
  const annualPremium = parseFloat(get('MOTOR ANNUAL PREMIUM') || get('ANNUAL PREMIUM') || 0) || 0;

  // If TP premium is 0 but we have net premium, derive TP = Net - OD. The OD
  // premium (NET_OD_PREMIUM) ALREADY INCLUDES the add-on (BASE_OD + add-on), so
  // add-on must NOT be subtracted again — doing so double-removes it and
  // understates TP. (e.g. GJ4/32503: Net 18515 − OD 6223 = 12292, not 9472.)
  if (tpPremium === 0 && netPremium > 0) {
    tpPremium = Math.max(0, netPremium - odPremium);
  }

  // NCB / Discount
  const ncbPct = parseFloat(get('NCB') || get('PREVIOUS NCB') || 0) || 0;
  const discountPct = parseFloat(get('OD DISCOUNT') || get('DISCOUNT') || 0) || 0;

  // Vehicle age — prefer the pre-calculated field from view, else derive from registration date
  let vehicleAge = null;
  const ageOfVehicle = get('AGE OF VEHICLE');
  if (ageOfVehicle != null && ageOfVehicle !== '' && !isNaN(parseInt(ageOfVehicle))) {
    vehicleAge = parseInt(ageOfVehicle, 10);
  } else if (registrationDate) {
    const regDate = new Date(registrationDate);
    if (!isNaN(regDate.getTime())) {
      const now = new Date();
      vehicleAge = Math.floor((now - regDate) / (365.25 * 24 * 60 * 60 * 1000));
    }
  }

  // Map vehicle class/type to our product codes. Some insurers (ICICI especially)
  // ship policy rows with NULL VEHICAL TYPE / VEHICAL CATEGORY, so fall back to
  // make+model heuristics when the explicit field is blank.
  let mappedVehicleType = mapVehicleType(vehicleClass || vehicleType || vehicalCategoryRaw);
  if (!mappedVehicleType) {
    mappedVehicleType = inferVehicleTypeFromMakeModel(make, model, seatingCapacity, cc);
  }

  // Map policy type to ins_product
  const insProduct = mapInsProduct(policyType);

  // Clean RTO code — extract just the alpha-numeric RTO prefix (e.g., "MH01"
  // from "MH-01-AB-1234"). Falls back to the RTO parsed from the tracker
  // number when the RTO/registration columns are blank.
  const cleanRTO = cleanRtoCode(rtoCode) || rtoFromTracker;

  return {
    insurerName: (insurerName || '').toString().trim(),
    policyType: (policyType || '').toString().trim(),
    vehicleClass: (vehicleClass || '').toString().trim(),
    vehicleType: mappedVehicleType,
    // Vehicle category uses the more-specific `VehicalCategory` when present
    // (e.g. "TW - Scooty" / "TW - Motorcycle" / "Car"); falls back to vehicleClass.
    // PrarambhMainId for joining to TRN_PrarambhMotorDetails (tonnage / GVW
    // fallback when VehicalCategory text doesn't carry the band).
    mainId: get('ID') || get('PrarambhMainId') || get('MAIN ID') || null,
    // City name — surfaced as a region candidate for insurers that label
    // rate-card regions by city (e.g. Reliance: LUCKNOW / MUMBAI / SURAT).
    city: (get('City Name') || get('CLIENT CITY NAME') || get('VEHICLE CITY') ||
           get('city_name') || '').toString().trim(),
    vehicleCategory: (vehicalCategoryRaw || vehicleClass || '').toString().trim(),
    make: (make || '').toString().trim(),
    model: (model || '').toString().trim(),
    vehicleSubModel: (vehicleSubModel || '').toString().trim(),
    vehicleRegNo,
    fuelType: (fuelType || '').toString().trim(),
    rtoCode: cleanRTO,
    segment: (segment || '').toString().trim(),
    cc: parseInt(cc, 10) || null,
    seatingCapacity,
    tonnage,
    tonnageMin,
    tonnageMax,
    tonnageCoarse,
    carrierType,
    businessType,
    // Corporate vs Individual ownership — inferred from the proposer name.
    // PCV bus rate cards split rates on this (e.g. TATA: "_Corporate" 31% vs
    // "_Individual" 40%). A company-style name → Corporate, else Individual.
    // Blank when no name is available (no narrowing).
    ownerType: (function () {
      const nm = (get('FULL NAME') || get('PROPOSER NAME') || get('FULLNAME_PROPOSER') ||
                  get('CONTACT PERSON') || '').toString().toUpperCase();
      if (!nm.trim()) return '';
      return /\b(LTD|LIMITED|PVT|PRIVATE|LLP|ENTERPRISE|TRANSPORT|LOGISTIC|TRAVELS?|ROADWAYS|CARRIER|CORP|COMPANY|INDUSTR|MOTORS|TRADERS|TRADING|&\s*CO\b|SERVICES|AGENC|ASSOCIATION|TRUST|FOUNDATION|SOCIETY|INFRA|CONSTRUCTION|BUILDERS|PHARMA|HOSPITAL|SCHOOL|COLLEGE|UNIVERSITY|FINANCE|LEASING|PRODUCTS|SOLUTIONS|TECHNOLOG|EXPORTS?|IMPORTS?|MILLS|FACTORY|UDYOG|AUTOMOBILE)\b/.test(nm)
        ? 'Corporate' : 'Individual';
    })(),
    // Finer owner classification for grids that split a row by owner class
    // (e.g. Go Digit School Bus → "School" / "Company" / "Individual").
    //   School   = proposer is the educational institution itself
    //   Company  = any other non-individual entity (company / society / trust)
    //   Individual = a natural person
    ownerClass: (function () {
      const nm = (get('FULL NAME') || get('PROPOSER NAME') || get('FULLNAME_PROPOSER') ||
                  get('CONTACT PERSON') || '').toString().toUpperCase();
      if (!nm.trim()) return '';
      if (/\b(SCHOOL|COLLEGE|UNIVERSITY|VIDYALAYA|VIDHYALAYA|VIDYA|PAATHSHALA|PATHSHALA|EDUCATION|EDUCATIONAL|INSTITUTE|INSTITUTION|ACADEMY|GURUKUL|CONVENT)\b/.test(nm)) return 'School';
      if (/\b(LTD|LIMITED|PVT|PRIVATE|LLP|ENTERPRISE|TRANSPORT|LOGISTIC|TRAVELS?|ROADWAYS|CARRIER|CORP|COMPANY|INDUSTR|MOTORS|TRADERS|TRADING|&\s*CO\b|SERVICES|AGENC|ASSOCIATION|TRUST|FOUNDATION|SOCIETY|INFRA|CONSTRUCTION|BUILDERS|PHARMA|HOSPITAL|FINANCE|LEASING|PRODUCTS|SOLUTIONS|TECHNOLOG|EXPORTS?|IMPORTS?|MILLS|FACTORY|UDYOG|AUTOMOBILE)\b/.test(nm)) return 'Company';
      return 'Individual';
    })(),
    idv,
    isHighEnd,
    addon: (addonPremium || 0) > 0,
    odPremium,
    tpPremium,
    netPremium,
    addonPremium,
    annualPremium,
    ncbPct,
    discountPct: discountPct || null,
    vehicleAge,
    insProduct,
    registrationDate,
    // Tenure bucket ('1+1' | '1+5' | '5+5') derived in bulk enrichment from
    // OD/TP policy term dates (TRN_PrarambhMotorMISUpdation). Drives which
    // multi-year Comp grid the policy routes to. Null when unknown.
    policyTenure: get('_tenureBucket') || null,
  };
}

/**
 * Map vehicle class/type text from policy to our product code.
 */
/**
 * Last-ditch vehicle-type inference from make+model when the explicit
 * vehicleType / vehicleClass / vehicleCategory columns are all blank.
 * Several insurers (notably ICICI Lombard) ship rows with all three NULL,
 * leaving us no SQL `product` filter — every TW model lands at "No rule
 * hit SQL". This heuristic catches the common make+model shapes without
 * requiring the source to be fixed upstream.
 */
function inferVehicleTypeFromMakeModel(make, model, seating, cc) {
  const m = String((make || '') + ' ' + (model || '')).toUpperCase();
  if (!m.trim()) return '';
  // Two-wheeler signals — model keywords are the most reliable.
  const TW_KEYS = /\b(PULSAR|SPLENDOR|PASSION|DISCOVER|PLATINA|CT100|AVENGER|DOMINAR|ACTIVA|JUPITER|FASCINO|ACCESS|DIO|BURGMAN|NTORQ|SHINE|UNICORN|CB\s|CBR|HORNET|XPULSE|HIMALAYAN|METEOR|CLASSIC\s*350|BULLET|INTERCEPTOR|CONTINENTAL|GIXXER|GSX|FZ\b|R15|MT\d|YZF|KTM|DUKE|RC\s*\d|APACHE|RTR|SPORT|XL\s*100|MAESTRO|AVIATOR|PLEASURE|VESPA|SCOOTY|DESTINI|XOOM|RAY|ALPHA|ZR|CHETAK|IQUBE|OLA\s+S\d|XTREME|GLAMOUR|HF\s*DELUXE|RADEON|NTORQ|RAIDER|RONIN|MAVRICK|SCRAM|GUERRILLA|SHOTGUN|HUNTER|STAR|CITY|JAWA|FORTY-?TWO|TVS\s+TVS|ELECTRIC\s*SCOOTER|AVENIS|BGAUSS|ATHER|RIZTA|EZ\b|TUMI|REVOLT|RV[0-9]|EELECTRIC|EV1|EV2|S1\s*PRO|EHX|EWX|RX[0-9])\b/;
  if (TW_KEYS.test(m)) return 'TW';
  // TW makes that are bike-only manufacturers (skip if model already used elsewhere).
  if (/\b(BAJAJ|TVS|HERO|HONDA\s+MOTORCYCLE|YAMAHA|SUZUKI\s+MOTORCYCLE|ROYAL\s*ENFIELD|KTM|JAWA|VESPA|APRILIA|DUCATI|HARLEY|TRIUMPH|BENELLI|BMW\s+MOTORRAD)\b/.test(m)) {
    // Bike-only OEMs: if seating <= 2 OR cc <= 500 it's overwhelmingly TW.
    if ((seating != null && seating <= 2) || (cc != null && cc > 0 && cc <= 500)) return 'TW';
  }
  // GCV / commercial pickup signals.
  if (/\b(BOLERO\s*PIK|TATA\s+ACE|TATA\s+SUPER\s+ACE|TATA\s+INTRA|TATA\s+LPT|TATA\s+SFC|TATA\s+LPK|MAHINDRA\s+JEETO|MAHINDRA\s+SUPRO|MAHINDRA\s+FURIO|ASHOK\s+LEYLAND|EICHER\s+PRO|EICHER\s+1[02][0-9]|EICHER\s+CARGO|FORCE\s+TRAVELLER|FORCE\s+TRAX|TIPPER|DUMPER|TRAILER|KING\s+KARGO|EV\s+CONTAINER|HD\s+EV|CONTAINER\b)\b/.test(m)) {
    return 'GCV';
  }
  // 3-wheeler passenger/cargo signals.
  if (/\b(PIAGGIO\s+APE|BAJAJ\s+RE\b|BAJAJ\s+MAXIMA|ATUL\s+AUTO|MAHINDRA\s+ALFA|TREO|CHAMPION\s+E\s*RICKSHAW|MAYURI|GEMINI|COMPACT\s+DIESEL|ELITE\s+CARGO|XTRA)\b/.test(m)) {
    // Most are PCV (passenger 3W). Cargo variants → GCV.
    if (/CARGO|GOODS|PIK|LOAD/.test(m)) return 'GCV';
    return 'PCV';
  }
  // Tractor / construction — MISC.
  if (/\b(TRACTOR|MAHINDRA\s+\d{3}\s*DI|EICHER\s+\d{3}|JCB|HARVEST|EXCAVATOR|LOADER|CRANE|BULLDOZER)\b/.test(m)) {
    return 'MISC';
  }
  // CAR fallback when seating / cc hints at private 4-wheeler.
  if (seating != null && seating >= 4 && seating <= 7) return 'CAR';
  return '';
}

/**
 * Indian Tier-1 metro list — used by Royal Sundaram (and similar) rate cards
 * that group rates as "Key Cities" (Tier-1 metros) / "Other Cities" (named
 * tier-2) / "Rest of State". Matched against the cluster name when no
 * city-specific Comp rule exists.
 */
const KEY_CITIES = new Set([
  'MUMBAI', 'MUMBAI THANE', 'NAVI MUMBAI', 'THANE', 'PUNE', 'DELHI', 'NEW DELHI',
  'BANGALORE', 'BENGALURU', 'CHENNAI', 'KOLKATA', 'KOLKATTA', 'HOWRAH', 'HYDERABAD',
  'AHMEDABAD', 'SURAT', 'JAIPUR', 'LUCKNOW', 'KANPUR', 'NAGPUR', 'INDORE', 'BHOPAL',
  'PATNA', 'VADODARA', 'COIMBATORE', 'VISAKHAPATANAM', 'VISAKHAPATNAM',
  'VIJAYAWADA', 'VIJAYWADA', 'BHUBANESHWAR', 'RANCHI', 'CHANDIGARH', 'GURGAON',
  'GURUGRAM', 'NOIDA', 'GHAZIABAD', 'FARIDABAD', 'MADURAI', 'KOCHI',
  'ERNAKULAM', 'ERNAKULAM/KOCHI', 'THIRUVANANTHAPURAM', 'TRIVANDRUM',
  'MYSORE', 'MYSURU', 'NASHIK', 'NASIK', 'AURANGABAD', 'RAIGARH',
  'JALANDHAR', 'LUDHIANA', 'AMRITSAR', 'DEHRADUN',
]);

/**
 * RTO-state-prefix → state full name. Used for matching against rule
 * `remarks` (Royal stores per-state Comp rates with state in remarks).
 */
const STATE_PREFIX_FULL = {
  AP: 'Andhra Pradesh', AR: 'Arunachal Pradesh', AS: 'Assam', BR: 'Bihar',
  CG: 'Chhattisgarh', CH: 'Chandigarh', DL: 'Delhi', DN: 'Dadra and Nagar Haveli',
  DD: 'Daman and Diu', GA: 'Goa', GJ: 'Gujarat', HP: 'Himachal Pradesh',
  HR: 'Haryana', JH: 'Jharkhand', JK: 'Jammu & Kashmir', KA: 'Karnataka',
  KL: 'Kerala', LD: 'Lakshadweep', MH: 'Maharashtra', ML: 'Meghalaya',
  MN: 'Manipur', MP: 'Madhya Pradesh', MZ: 'Mizoram', NL: 'Nagaland',
  OD: 'Odisha', OR: 'Odisha', PB: 'Punjab', PY: 'Puducherry',
  RJ: 'Rajasthan', SK: 'Sikkim', TN: 'Tamil Nadu', TR: 'Tripura',
  TS: 'Telangana', UA: 'Uttarakhand', UK: 'Uttarakhand', UP: 'Uttar Pradesh',
  WB: 'West Bengal', AN: 'Andaman and Nicobar', LA: 'Ladakh',
};

/**
 * Given a cluster city + state hint, return ordered tier candidates that
 * Royal-style insurers store rates under. Caller appends these to the
 * cluster-fallback chain when initial city-region lookup misses.
 */
function inferLocationTiers(cluster, stateName, insurerSlug) {
  const c = String(cluster || '').toUpperCase().trim();
  const s = String(stateName || '').toUpperCase().trim();
  const tiers = [];
  // Royal Sundaram's Pvt-Car Comp grid prices only the genuine metros as
  // "Key Cities" — its tier-2 hubs (Aurangabad, Nashik, Nagpur) are NOT Key
  // Cities even though the global KEY_CITIES heuristic lists them. The
  // operator's PR State_For_TP_ULR confirms it: Mumbai/Pune carry the Key
  // Cities rate (0.29), while Aurangabad takes "Other Cities" (0.235), and
  // Nashik/Nagpur have their own dedicated "Nasik & Nagpur" tier. Without this
  // narrowing, an Aurangabad car (RTO MH20) wrongly headlines the Key Cities
  // rate. Scoped to Royal so other insurers' Key-Cities heuristic is untouched.
  const ROYAL_NON_KEY_CITIES = new Set([
    'AURANGABAD', 'NASHIK', 'NASIK', 'NAGPUR',
  ]);
  const isRoyal = insurerSlug === 'royal_sundaram';
  const isKeyCity = KEY_CITIES.has(c) && !(isRoyal && ROYAL_NON_KEY_CITIES.has(c));
  if (isKeyCity) tiers.push('Key Cities');
  // Royal files Nashik & Nagpur under a dedicated combined tier — prefer it
  // for those clusters before the generic Other Cities / Rest of State.
  if (isRoyal && /^(NASHIK|NASIK|NAGPUR)$/.test(c)) tiers.push('Nasik & Nagpur');
  // Always also try Other Cities + Rest of State as broader fallbacks.
  tiers.push('Other Cities', 'Rest of State');
  // Royal-style "<STATE>_OTHERS" convention for the rest-of-state TW/2W
  // bucket (e.g. MAHARASHTRA_OTHERS, KARNATAKA_OTHERS, KERALA_OTHERS,
  // TN_OTHERS). Only added when we have a state name to plug in.
  if (s) {
    tiers.push(`${s}_OTHERS`);
    // Combined-state convention for AP/Telangana under the common card.
    if (/ANDHRA|TELANGANA/i.test(s)) tiers.push('AP&TELANGANA_OTHERS');
  }
  // Country-wide buckets (Royal-style 3W E-Rickshaw catalog uses "Pan India"
  // / "Delhi NCR" / "Tamil Nadu" as quasi-regions for niche product rates).
  tiers.push('Pan India');
  return tiers;
}

function mapVehicleType(vehicleText) {
  if (!vehicleText) return '';
  // Normalize dots/dashes/extra punctuation so "Pvt.Car" matches "PVT CAR"
  const vt = vehicleText.toUpperCase().trim().replace(/[._\-]+/g, ' ').replace(/\s+/g, ' ');

  if (vt.includes('TWO WHEELER') || vt.includes('2 WHEELER') || vt.includes('2W') || vt.includes('BIKE') || vt.includes('SCOOTER') || vt.includes('SCOOTY') || vt.startsWith('TW ') || vt === 'TW') return 'TW';
  if (vt.includes('PRIVATE CAR') || vt.includes('PVT CAR') || vt.includes('MOTOR CAR') || vt.includes('4 WHEELER') || vt.includes('4W') || vt === 'CAR') return 'CAR';
  if (vt.includes('GCV') || vt.includes('GOODS CARRYING') || vt.includes('COMMERCIAL VEHICLE') || vt.includes('TRUCK') || vt.includes('LCV') || vt.includes('HCV')) return 'GCV';
  if (vt.includes('PCV') || vt.includes('PASSENGER') || vt.includes('BUS') || vt.includes('TAXI') || vt.includes('AUTO')) return 'PCV';
  if (vt.includes('MISCELLANEOUS') || vt.includes('MISC') || vt.includes('CE') || vt.includes('TRACTOR')) return 'MISC';

  return vt;
}

/**
 * Map policy type text to ins_product for rate_type filtering.
 */
function mapInsProduct(policyType) {
  if (!policyType) return '';
  const pt = policyType.toUpperCase().trim();

  if (pt.includes('COMPREHENSIVE') || pt.includes('PACKAGE') || pt.includes('COMP') || pt === 'PKG') return 'Comp';
  if (pt.includes('STANDALONE') || pt.includes('SAOD') || pt.includes('OD ONLY') || pt.includes('SOD')) return 'SAOD';
  if (pt.includes('THIRD PARTY') || pt.includes('TP ONLY') || pt.includes('LIABILITY') || pt.includes('SATP') || pt === 'TP' || pt === 'ACT') return 'TP';
  if (pt.includes('BUNDLED') || pt.includes('1+1')) return '1+1';

  return '';
}

/**
 * Map insurer name from the view to our config slug.
 */
function resolveInsurerSlug(insurerName) {
  if (!insurerName) return null;
  const name = insurerName.toUpperCase().trim();

  const mappings = [
    { patterns: ['DIGIT', 'GO DIGIT'], slug: 'go_digit' },
    { patterns: ['CHOLAMANDALAM', 'CHOLA MS', 'CHOLA'], slug: 'chola_ms' },
    { patterns: ['BAJAJ', 'BAJAJ ALLIANZ'], slug: 'bajaj_allianz' },
    { patterns: ['UNITED INDIA'], slug: 'united_india_insurance' },
    { patterns: ['ICICI LOMBARD'], slug: 'icici_lombard' },
    { patterns: ['HDFC ERGO'], slug: 'hdfc_ergo' },
    { patterns: ['TATA AIG'], slug: 'tata_aig' },
    { patterns: ['NATIONAL'], slug: 'national_insurance' },
    { patterns: ['NEW INDIA'], slug: 'new_india_assurance' },
    { patterns: ['ORIENTAL'], slug: 'oriental_insurance' },
    { patterns: ['SBI GENERAL'], slug: 'sbi_general' },
    { patterns: ['RELIANCE'], slug: 'reliance' },
    { patterns: ['IFFCO TOKIO', 'IFFCO'], slug: 'iffco_tokio' },
    { patterns: ['KOTAK'], slug: 'kotak' },
    { patterns: ['LIBERTY'], slug: 'liberty_videocon' },
    { patterns: ['MAGMA'], slug: 'magma_hdi' },
    { patterns: ['NAVI'], slug: 'navi' },
    { patterns: ['SHRIRAM'], slug: 'shriram' },
    { patterns: ['ACKO'], slug: 'acko' },
    { patterns: ['ZUNO', 'EDELWEISS'], slug: 'zuno' },
    { patterns: ['FUTURE GENERALI'], slug: 'future_generali' },
    { patterns: ['ROYAL SUNDARAM'], slug: 'royal_sundaram' },
    { patterns: ['UNIVERSAL SOMPO', 'SOMPO'], slug: 'universal_sompo' },
    { patterns: ['STAR HEALTH'], slug: 'star_health' },
    { patterns: ['RAHEJA QBE'], slug: 'raheja_qbe' },
  ];

  for (const m of mappings) {
    for (const pat of m.patterns) {
      if (name.includes(pat)) return m.slug;
    }
  }

  // Try generating a slug from the name
  const slug = insurerName
    .toLowerCase()
    .replace(/\s+general\s+insurance.*$/i, '')
    .replace(/\s+life\s+insurance.*$/i, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

  return slug || null;
}

/**
 * Clean RTO code — extract prefix like "MH01" from various formats.
 */
function cleanRtoCode(rtoCode) {
  if (!rtoCode) return '';
  const cleaned = rtoCode.toString().trim().toUpperCase().replace(/[\s-]/g, '');
  // A real RTO code is 2 alpha + 1-2 numeric (e.g. MH01, DL8). Extract that
  // prefix. When the value isn't a valid RTO code (garbage placeholders like
  // "NEW", "NA", "-", a bare city name), return '' so callers fall back to
  // other sources (tracker-derived RTO, state name).
  const match = cleaned.match(/^([A-Z]{2}\d{1,2})/);
  return match ? match[1] : '';
}

/**
 * Smart-filter rules by matching segment text to policy CC and make.
 * Segments like "MC <= 180 Hero/Honda", "MC_180-350_Others", "SC/EV" etc.
 */
// Known per-insurer make buckets that can appear as a rate_type suffix.
// When a rate_type ends with one of these, the match depends on the policy's make,
// not on the rr.make column (which is often NULL for these rules).
const MAKE_BUCKETS = {
  'Tata': ['TATA'],
  'Kia': ['KIA'],
  'Mahindra': ['MAHINDRA', 'MAHINDRA & MAHINDRA'],
  'Hyundai': ['HYUNDAI'],
  'Toyota': ['TOYOTA'],
  'Maruti': ['MARUTI', 'MARUTI SUZUKI'],
  'Honda': ['HONDA'],
  'Ford': ['FORD'],
  'HEV': [], // special: high-end / luxury bucket — matched only if policy is high-end
  'Others': [], // catch-all: matches any make that isn't in a specific bucket above
};
const ALL_SPECIFIC_MAKES = Object.entries(MAKE_BUCKETS)
  .filter(([k]) => k !== 'HEV' && k !== 'Others')
  .flatMap(([, v]) => v);

/**
 * Given a rate_type like "1+3_CD2_Kia" / "CD2_Others" / "CD2_HEV" / "CD2", return
 * the trailing make-bucket if the suffix corresponds to a known bucket (case-
 * insensitive match against MAKE_BUCKETS keys). Returns null if there is no
 * make suffix (e.g. plain "CD2" or "1+3_CD2").
 */
function extractRateMakeBucket(rateType) {
  if (!rateType) return null;
  // Check the trailing token (after the last underscore, or the whole string
  // if there is no underscore) — that covers "CD2_Kia", "HEV", "CD2_Others".
  const parts = rateType.split('_');
  const last = parts[parts.length - 1];
  for (const key of Object.keys(MAKE_BUCKETS)) {
    if (key.toLowerCase() === last.toLowerCase()) return key;
  }
  return null;
}

/**
 * Tenure prefix of a rate_type. "1+3_CD2" → "1+3", "CD2_Kia" → null.
 * Rate cards encode multi-year bundled products (1+1, 1+3, 3+3, 1+5, 5+5) in the
 * rate_type prefix. These should not match a plain Comp/SAOD/TP policy.
 */
function extractRateTenure(rateType) {
  if (!rateType) return null;
  const m = rateType.match(/^(1\+1|1\+3|2\+2|3\+3|1\+5|5\+5)_/i);
  return m ? m[1] : null;
}

/**
 * Collapse a tenure prefix (or a policy's derived OD+TP year plan) into one of
 * three routing buckets so policies and rate-cards match even when the exact
 * year combo differs:
 *   '1+1'             → '1+1'  (annual OD + annual TP)
 *   '1+3' / '1+5'     → '1+5'  (annual OD + long TP, i.e. bundled new vehicle)
 *   '2+2','3+3','5+5' → '5+5'  (long-term OD + long-term TP)
 * Returns null for unrecognised input.
 */
function tenureToBucket(t) {
  if (!t) return null;
  const s = String(t).trim();
  if (s === '1+1') return '1+1';
  if (s === '1+3' || s === '1+5') return '1+5';
  if (s === '2+2' || s === '3+3' || s === '5+5') return '5+5';
  return null;
}

/**
 * Parse a tonnage range out of a rule's segment text.
 *   "GCV4 2.5 To 3.5T"   → { min: 2.5, max: 3.5 }
 *   "GCV4 upto 2.5T"     → { min: 0,   max: 2.5 }
 *   "GCV4 44T+"          → { min: 44,  max: Infinity }
 *   "GCV4 12 to 20T"     → { min: 12,  max: 20 }
 * Returns null if no tonnage tokens detected.
 */
function extractSegmentTonnageRange(seg) {
  if (!seg) return null;
  // Normalize whitespace + unicode dashes to the ASCII hyphen so one regex
  // covers "12-20T", "12–20T", and "12 to 20T" alike.
  const s = seg.replace(/\u2013|\u2014/g, '-').replace(/\s+/g, ' ');
  let m;
  if ((m = s.match(/(\d+(?:\.\d+)?)\s*(?:to|-)\s*(\d+(?:\.\d+)?)\s*Tn?\b/i))) {
    return { min: parseFloat(m[1]), max: parseFloat(m[2]) };
  }
  if ((m = s.match(/upto\s*(\d+(?:\.\d+)?)\s*Tn?\b/i))) {
    return { min: 0, max: parseFloat(m[1]) };
  }
  if ((m = s.match(/(\d+(?:\.\d+)?)\s*Tn?\s*\+/i))) {
    return { min: parseFloat(m[1]), max: Infinity };
  }
  // TATA CV-style bands WITHOUT a "T" suffix: "GCV > 2 <= 2.5",
  // "GCV <= 2", "GCV > 12 <= 20", "GCV > 45". Anchor on a leading
  // GCV/PCV/MISC token so we don't grab CC / seating numbers from other
  // segment text. Order matters: the ">X <=Y" form must be tested before
  // the bare "<=Y" form. (Without this, these no-suffix bands had null
  // ranges, so a coarse category like "Upto 2.5Tn" text-matched the higher
  // 2-2.5 band even when the actual GVW — e.g. 1.6T — belongs in "<= 2".)
  if (/\b(?:GCV|PCV|MISC)\b/i.test(s)) {
    if ((m = s.match(/>\s*(\d+(?:\.\d+)?)\s*<=\s*(\d+(?:\.\d+)?)/))) {
      return { min: parseFloat(m[1]), max: parseFloat(m[2]) };
    }
    if ((m = s.match(/<=\s*(\d+(?:\.\d+)?)/))) {
      return { min: 0, max: parseFloat(m[1]) };
    }
    if ((m = s.match(/>\s*(\d+(?:\.\d+)?)\s*$/))) {
      return { min: parseFloat(m[1]), max: Infinity };
    }
  }
  return null;
}

function filterRulesByPolicy(rules, params, _trace) {
  const cc = params.cc;
  const make = (params.make || '').toUpperCase();
  const model = (params.model || '').toUpperCase();
  const fuelType = (params.fuelType || '').toUpperCase();
  // Prefer the more specific vehicleCategory (e.g. "TW - Scooty") over vehicleClass
  // (often just "Two Wheeler").
  const vehicleCategory = ((params.vehicleCategory || params.vehicleClass) || '').toUpperCase();
  const seating = params.seatingCapacity;
  const tonnage = params.tonnage;
  const carrier = (params.carrierType || '').toUpperCase();
  const policyHasAddon = params.addon === true;
  // Tenure bucket ('1+1' | '1+5' | '5+5') derived from OD/TP term dates in
  // bulk enrichment. Null when unknown — then tenure-prefixed rules pass
  // freely (informational), preserving prior behaviour for insurers/policies
  // where we can't derive a plan.
  const policyTenure = params.policyTenure || null;
  const isHighEnd = params.isHighEnd === true;

  // Which make-bucket does this policy belong to?
  let policyBucket = null;
  for (const [bucket, aliases] of Object.entries(MAKE_BUCKETS)) {
    if (aliases.some(a => make === a || make.startsWith(a + ' '))) {
      policyBucket = bucket;
      break;
    }
  }
  // Not in a specific bucket → falls into 'Others' (or 'HEV' if high-end)
  const policyBucketFallback = isHighEnd ? 'HEV' : 'Others';

  // Policy NCB status — used to filter rate_types whose name encodes NCB / NON_NCB.
  const policyHasNCB = (params.ncbPct || 0) > 0;

  // State name for matching against rule.remarks — Royal Sundaram stores
  // per-state Comp rates in tier regions ("Key Cities" / "Other Cities" /
  // "Rest of State") with the state's full name in `remarks`. Prefer the
  // RTO-prefix-derived state because the source `_stateName` column often
  // carries the agent's state (Uttar Pradesh from a UP1 tracker prefix)
  // even when the vehicle is registered elsewhere (HR20). The vehicle's
  // RTO is the true state for rate matching.
  const policyStateRaw = String(params._stateName || '').trim();
  const policyStateFromRto = STATE_PREFIX_FULL[rtoStatePrefix(params.rtoCode)] || '';
  const policyStateFull = (policyStateFromRto || policyStateRaw || '').toUpperCase();

  // Pre-scan: does the candidate set contain a DEDICATED rickshaw / 3W
  // segment (e.g. Digit's "E-Rickshaw" or "PCV3W non-diesel Age 6+")?
  // A "dedicated" rickshaw segment matches the 3W pattern but is NOT a Taxi
  // segment. When one exists, a 3-wheeler policy must price off it and must
  // NOT borrow a generic PCV-Taxi rate — Digit ships both an "E-Rickshaw" row
  // (55% TP) and a "Taxi upto 5 seater Electric" row (12.5% TP) for the same
  // region, and the taxi row's fuel + seating bonuses otherwise outscore the
  // rickshaw row. The exclusivity gate below uses this to hard-drop taxis.
  const RICKSHAW_SEG_RE = /E[-\s]?RIKSHAW|E[-\s]?RICKSHAW|\bRICKSHAW\b|\bAUTO\s*RICKSHAW\b|\bPCV3W?\b|\b3W\b|\b3\s*WHEELER\b|\bTHREE\s*WHEELER\b|\bGCV3W?\b(?![.\d])|\bGCV\s*3W\b|\bGCV\s*3(?![.\d])|GCCV[\s_-]*3W?\b|GCCV3\b|\bPCV\s*AUTO\b/i;
  const hasDedicatedRickshawSeg = rules.some(r => {
    const s = String(r.segment || '');
    return RICKSHAW_SEG_RE.test(s) && !/\bTAXI\b/i.test(s);
  });
  // Pre-scan: does the candidate set contain a Taxi-family / Bus-family
  // segment?  Used by the strict PCV sub-type partition below so we only
  // enforce "taxi policy → taxi segment" (and "bus policy → bus segment")
  // when a same-family alternative actually exists — otherwise a policy with
  // only cross-family rules available would be stranded at no-rule.
  const hasTaxiSeg = rules.some(r => /TAXI\b|\bMAXI\s*CAB\b|\bBIG\s*TAXI/i.test(String(r.segment || '')));
  const hasBusSeg  = rules.some(r => /\bBUS\b|\bSTAGE\s*CARR?IAGE\b|\bCONTRACT\s*CARR?IAGE\b/i.test(String(r.segment || '')));

  // Royal Comp discount-band: collect the thresholds of any ">N" open band
  // among the candidate rules. A discount sitting exactly on a closed band's
  // upper bound must defer to an open ">N" band when one exists at that bound
  // (operator pays ">70"=0.26 for a 70% discount), whereas a boundary with no
  // open band above it falls to the closed band below ("60-70" means 61-70, so
  // 60% → "50-60"). Both "60-70" and ">70" carry rate_type Comp, so without this
  // a 70% discount would survive in BOTH bands and the equal-score tie-break
  // would arbitrarily keep the lower rate.
  const royalOpenBandThresholds = new Set();
  for (const r of rules) {
    if (r.insurer === 'royal_sundaram' && /^COMP$/i.test(String(r.rate_type || ''))) {
      const mm = /^>\s*(\d+(?:\.\d+)?)$/.exec(String(r.volume_tier || '').trim());
      if (mm) royalOpenBandThresholds.add(parseFloat(mm[1]));
    }
  }

  // Royal Sundaram Pvt-Car standalone-TP (PC SATP sheet): each segment carries
  // BOTH a SATP_ACT (the act-only / pure-TP commission, the operator's headline
  // for a Liability policy — e.g. Pune 1000-1500cc = 8%) and a SATP_PACK (the
  // bundled-package variant). A genuine TP/Liability policy must take the ACT
  // rate, not PACK. pickPrimaryRateRule de-prioritises _ACT (because Royal also
  // files 0% ACT rows), which wrongly headlines PACK for these. Pre-scan for an
  // _ACT sibling so we can drop the PACK variant for a TP policy without
  // stranding a region that only files PACK.
  const hasSatpActSibling = rules.some(r =>
    /_ACT\b|^ACT(_|$)/i.test(String(r.rate_type || '')) && r.rate_value != null);

  // Special-body GCV detection. Go Digit's HCV grid ships separate rate
  // columns (encoded as rate_type prefixes DUMPER_/OIL_TANKER_/GAS_TANKER_)
  // for tipper/dumper, oil-tanker and gas-tanker bodies, alongside the plain
  // goods-carrier rate. Those special-body rates are HIGHER and must apply
  // ONLY to the matching body type — a regular haulage truck (e.g. TATA LPT,
  // EICHER PRO) must never inherit the dumper/tanker rate. We detect the
  // policy's body from its model + category text; when no special keyword is
  // present the vehicle is a regular goods carrier.
  // Body detection draws on make + model + category text. Beyond the explicit
  // DUMPER/TIPPER keyword, a few make/model codes denote a tipper body even
  // without the word — Tata's "LPK" tipper chassis is the common one (LPK =
  // tipper variant of the LPT haulage truck). Unknown models default to a
  // regular goods carrier (non-dumper): the special-body rate is HIGHER, so
  // over-applying it is the costly error — when in doubt, price as plain.
  // (E.g. EICHER PRO 6031 is a haulage tractor → non-dumper.)
  const _bodyText = `${params.make || ''} ${params.model || ''} ${vehicleCategory}`.toUpperCase();
  const DUMPER_BODY_RE = /\b(DUMPER|TIPPER|TIPER|DIPPER)\b|\bLPK\b/;
  const policyIsDumperBody = DUMPER_BODY_RE.test(_bodyText);
  const policyIsTankerBody = /\bTANKER\b/.test(_bodyText);
  const policyIsGasTanker  = policyIsTankerBody && /\bGAS\b|\bLPG\b|\bCNG\b/.test(_bodyText);
  const policyIsOilTanker  = policyIsTankerBody && !policyIsGasTanker;

  // Aged commercial-vehicle Comp→SATP fallback. Go Digit's GCV/HCV grid leaves
  // the Comprehensive commission columns (…_CD2) blank for trucks older than
  // 5 years, publishing only SATP (liability) rates for those age bands. A
  // Comprehensive policy on such an aged truck would otherwise drop every SATP
  // rule (Comp policies normally price off the Comp column) and strand at
  // no-rule — even though the policy's OD is negligible and the operator pays
  // off the SATP rate. We pre-scan for a usable Comp *commission* rate matching
  // this policy's age + body; when none exists, we let the SATP rate survive
  // the Comp/SATP gate below as the fallback. Scoped to commercial vehicles so
  // the strict Comp/SATP split on CAR/TW is unaffected.
  const _vtClass = String(params.vehicleType || '').toUpperCase();
  const _isCommercialVeh = _vtClass === 'GCV' || _vtClass === 'PCV' || _vtClass === 'MISC';
  const _ageWithinRule = (r) => {
    if (params.vehicleAge == null) return true;
    if (r.vehicle_age_min != null && params.vehicleAge < r.vehicle_age_min) return false;
    if (r.vehicle_age_max != null && params.vehicleAge > r.vehicle_age_max) return false;
    return true;
  };
  // Weight-band match for the aged-fallback pre-scans. Without it the scans
  // below would treat a usable Comp rate from a DIFFERENT tonnage segment
  // (e.g. GCV4 12-20T) as proof that "a Comp rate exists" for THIS policy —
  // which wrongly suppressed the aged Comp→SATP fallback for a 20-40T truck
  // whose own band has only null Comp cells. Overlap semantics; rules with no
  // band (null min/max) are weight-agnostic and always pass.
  const _ton = params.tonnage != null ? params.tonnage
             : (params.tonnageMin != null ? params.tonnageMin : null);
  const _weightWithinRule = (r) => {
    if (_ton == null) return true;
    if (r.weight_band_min != null && _ton < r.weight_band_min) return false;
    if (r.weight_band_max != null && _ton > r.weight_band_max) return false;
    return true;
  };
  const _isSpecialBodyRt = (rt) =>
    /^DUMPER[_\s]/.test(rt) || /^OIL[_\s]*TANKER[_\s]/.test(rt) || /^GAS[_\s]*TANKER[_\s]/.test(rt);
  // The Prarambh source carries no dumper/tipper body classification, so we
  // price as PLAIN (non-special-body) by default. A dumper/tipper rate is only
  // allowed to stand in when NO usable plain commission rate exists for this
  // policy's age + weight band — i.e. the card publishes a rate for the special
  // body only. CD1 (discount cap) and FLEXI rows aren't commissions, so they
  // don't count as a "usable plain rate".
  const _hasUsablePlain = rules.some(r => {
    const rt = (r.rate_type || '').toUpperCase();
    if (_isSpecialBodyRt(rt)) return false;
    if (/CD1/.test(rt) || /^FLEXI/.test(rt)) return false;
    return r.rate_value != null && _ageWithinRule(r) && _weightWithinRule(r);
  });
  const _bodyAllowsRt = (rt) => {
    // Dumper: explicit body match OR plain-rate-absent fallback (default plain;
    // only fall back to dumper when no plain rate is available).
    if (/^DUMPER[_\s]/.test(rt)) return policyIsDumperBody || !_hasUsablePlain;
    // Tankers are genuinely distinct vehicles — keep strict (no plain fallback).
    if (/^OIL[_\s]*TANKER[_\s]/.test(rt)) return policyIsOilTanker;
    if (/^GAS[_\s]*TANKER[_\s]/.test(rt)) return policyIsGasTanker;
    return true;
  };
  const _hasUsableComp = rules.some(r => {
    const rt = (r.rate_type || '').toUpperCase();
    // A Comprehensive *commission* rate (CD2 column), body-appropriate, with a
    // real value, for this policy's age band. CD1 is a discount cap (not a
    // commission), so it doesn't count toward "Comp rate available".
    const isCompCommission = /(^|_)COMP(_|$)/.test(rt) && /CD2/.test(rt);
    return isCompCommission && r.rate_value != null && _bodyAllowsRt(rt)
        && _ageWithinRule(r) && _weightWithinRule(r);
  });
  const allowAgedSatpFallback = _isCommercialVeh
    && String(params.insProduct || '').toUpperCase() === 'COMP'
    && !_hasUsableComp;

  // Score each rule by how well its segment matches the policy
  const scored = rules.map(rule => {
    const seg = (rule.segment || '').toUpperCase();
    const rt = (rule.rate_type || '').toUpperCase();
    let score = 0;
    let matches = true;

    // Extended-Warranty sheet exclusion: TATA ships a separate
    // "Pvtcar_Extended Warranty" catalogue (lower rate, e.g. 22%) that only
    // applies to policies that actually bundle an extended-warranty cover —
    // a niche product. The standard PCI Package rate (e.g. 28%) is the
    // default. We can't reliably detect extended-warranty policies, and the
    // operator's payout uses the standard rate, so drop the Extended Warranty
    // rules outright; otherwise they shadow the PCI standard rate in dedup.
    if (/extended\s*warranty/i.test(String(rule.sheet_name || ''))) {
      matches = false;
    }

    // --- Rate-type encoded filters (tenure + NCB flag + make bucket suffix) ---
    const rtTenure = extractRateTenure(rule.rate_type);
    const rtBucket = extractRateMakeBucket(rule.rate_type);

    // Drop tenure-prefixed rules unless the policy is that tenure product.
    // When the policy's tenure is unknown (policyTenure === null), let the
    // rule pass — the rate card's tenure is informational and shouldn't
    // veto a rule that's otherwise correct.  ICICI rate cards encode
    // tenure (1+1/1+5/2+2/3+3) on every rate_type; treating null as
    // "doesn't match" was eliminating all of them.
    // Compare by BUCKET, not literal token: a 3+3 policy ('5+5' bucket) must
    // match a "5+5_MAX_CD2" rule, and a card may not carry the exact year
    // combo. When both buckets resolve and differ, drop the rule.
    if (matches && rtTenure && policyTenure != null) {
      const rb = tenureToBucket(rtTenure);
      const pb = tenureToBucket(policyTenure);
      if (rb && pb && rb !== pb) matches = false;
    }

    // NCB / NON_NCB encoded in rate_type (e.g. COMP_NCB vs COMP_NON_NCB).
    // Match the policy's NCB status. Rules with no NCB keyword apply to both.
    if (matches) {
      const rtU = String(rt).toUpperCase();
      // Non-NCB token. Two encodings:
      //   (a) go_digit / tata_aig: "NON_NCB" / "Non NCB" (prefix form)
      //   (b) ICICI: a "no-NCB" qualifier AFTER a colon/equals —
      //       "NCB:None", "NCB:No", "NCB=0", "NCB:Zero".
      // Case-insensitive so tata's "Non NCB" (not "NON NCB") is caught and
      // ICICI's "NCB:None" is classified Non-NCB (the bare-\bNCB\b test below
      // otherwise mis-reads "NCB:None" as a positive-NCB rate).
      const rtIsNonNcb = /NON[_\s-]*NCB|NCB\s*[:=]\s*(NONE|NO\b|NON|ZERO|0)/.test(rtU);
      // Positive-NCB token: a bare NCB keyword that is NOT a non-NCB qualifier
      // (go_digit COMP_NCB, ICICI "NCB:GT0", tata "NCB:NCB").
      const rtIsNcb = !rtIsNonNcb && /\bNCB\b|_NCB(_|$)/.test(rtU);
      if (rtIsNonNcb && policyHasNCB) matches = false;
      else if (rtIsNcb && !policyHasNCB) matches = false;
    }

    // Special-body rate_type gate (Go Digit HCV grid). DUMPER_/OIL_TANKER_/
    // GAS_TANKER_ rates apply only to the matching body. A regular goods
    // carrier must price off the plain (non-prefixed) rate, never the
    // special-body column — otherwise a haulage truck inherits the higher
    // dumper/tanker rate (e.g. 43.5% vs the ~28% plain rate the operator pays).
    if (matches) {
      if (/^DUMPER[_\s]/.test(rt) && !policyIsDumperBody) matches = false;
      else if (/^OIL[_\s]*TANKER[_\s]/.test(rt) && !policyIsOilTanker) matches = false;
      else if (/^GAS[_\s]*TANKER[_\s]/.test(rt) && !policyIsGasTanker) matches = false;
    }

    // NCB encoded in sub_type / remarks (Zuno convention): a Pvt Car
    // grid splits rates into "NCB 1-99" (any positive NCB) and a separate
    // "NCB = 0" / "Without NCB" override (e.g. 15%). The token lives in
    // sub_type ("NCB=0") and/or remarks ("NCB 1-99" / "NCB = 0"), NOT in
    // rate_type — so the rate_type check above misses it. Match the
    // policy's NCB status against these and prefer the exact NCB band.
    if (matches) {
      const ncbText = `${rule.sub_type || ''} ${rule.remarks || ''}`;
      const ruleIsNcbZero = /\bNCB\s*=?\s*0\b|\bzero\s*ncb\b|\bwithout\s*ncb\b/i.test(ncbText);
      const ruleIsNcbPositive = !ruleIsNcbZero && /\bNCB\s*1\s*-\s*99\b|\bwith\s*ncb\b/i.test(ncbText);
      // The canonical zero-NCB OVERRIDE carries sub_type='NCB=0' explicitly
      // (Zuno's Pan India "NCB = 0 → 15%" floor). A region-specific rate
      // that merely *mentions* "NCB = 0" in remarks (no sub_type) is the
      // mislabelled NCB-1-99 sibling and must NOT beat the override. So the
      // explicit-subtype override gets a much bigger boost.
      const ruleIsNcbZeroOverride = /^\s*NCB\s*=?\s*0\s*$/i.test(String(rule.sub_type || ''));
      // NCB only discounts the OD premium — it never changes the statutory
      // TP rate. For a pure TP policy, NCB-specific rules (especially the
      // NCB=0 OD override) are irrelevant: drop the explicit NCB=0 override
      // so it can't beat the real SATP/TP rate, and skip NCB band matching.
      const policyIsPureTp = String(params.insProduct || '').toUpperCase() === 'TP';
      if (policyIsPureTp) {
        if (ruleIsNcbZeroOverride) matches = false;   // OD-only override — not a TP rate
        // else: leave TP rules untouched (no NCB filtering for TP)
      } else if (ruleIsNcbZero && policyHasNCB) {
        matches = false;                 // NCB=0 rule, but policy has NCB → drop
      } else if (ruleIsNcbPositive && !policyHasNCB) {
        matches = false;                 // NCB 1-99 rule, but policy is zero-NCB → drop
      } else if (ruleIsNcbZeroOverride && !policyHasNCB) {
        score += 20;                     // canonical zero-NCB override → wins dedup
      } else if (ruleIsNcbZero && !policyHasNCB) {
        score += 8;                      // exact NCB=0 match (remark-level)
      } else if (ruleIsNcbPositive && policyHasNCB) {
        score += 8;                      // exact NCB 1-99 match
      }
    }

    // Shriram claim-status / tanker twins encoded in `remarks`. Several GCV
    // segments file the SAME segment + region + weight + age + rate_type twice
    // (or thrice), distinguished ONLY by a remark:
    //   "All Tankers"                                         → tanker bodies only
    //   "Excluding Tankers & for New/Rollover Cases."         → non-tanker, NCB = 0
    //   "Excluding Tankers & Our Claim- Free renewal cases."  → non-tanker, NCB > 0
    // The claim-free (any positive NCB) renewal takes the higher "Claim-Free"
    // rate (e.g. HCV 42501-50000 GVW Gujarat = 20); a zero-NCB new/rollover
    // takes the "New/Rollover" rate (17.5). Gate on the remark so the correct
    // twin survives — otherwise the dedup picks one arbitrarily.
    if (matches && rule.insurer === 'shriram' && rule.remarks) {
      const rem = String(rule.remarks).toUpperCase();
      const remTankerOnly  = /\bALL\s+TANKERS?\b/.test(rem);
      const remExclTankers = /EXCLUDING\s+TANKERS?/.test(rem);
      const remClaimFree   = /CLAIM[\s-]*FREE\s+RENEWAL/.test(rem);
      const remNewRollover = /NEW\s*\/\s*ROLLOVER|NEW\s+OR\s+ROLLOVER/.test(rem);
      // Tanker applicability
      if (remTankerOnly && !policyIsTankerBody) matches = false;
      else if (remExclTankers && policyIsTankerBody) matches = false;
      // NCB / claim-status twin (claim-free renewal ↔ positive NCB)
      if (matches) {
        if (remClaimFree && !policyHasNCB) matches = false;       // claim-free rate, but zero NCB
        else if (remNewRollover && policyHasNCB) matches = false; // new/rollover rate, but has NCB
      }
    }

    // Shriram PCV passenger sub-segmentation. The region PCV 4-wheeler grid
    // partitions passenger vehicles by SEATING into sub_type bands, NOT by a
    // Taxi/Bus keyword in the segment text:
    //   "Upto 6+1"      → small taxi / car-cab, ≤ 7 seats   (sc null-7)
    //   "7 to 10"       → 7-10 seater                       (sc 7-10)
    //   "Corporate Bus" → contract/corporate passenger bus  (sc null-null)
    //   "School Bus"    → school bus, seat-banded
    // The generic CAT_KEYWORDS scorer can't read these — the "Upto 6+1"/"7 to
    // 10" segment text has no TAXI token — so a ≤6-seat taxi (no seating
    // extracted) deduped onto the "Corporate Bus" sibling (same rate_type, +2
    // PCV-BUS-hint). Gate on the policy's seating + passenger class so the
    // correct band wins; then pick the right remark variant.
    if (matches && rule.insurer === 'shriram' &&
        String(params.vehicleType || '').toUpperCase() === 'PCV') {
      const st = String(rule.sub_type || '').toUpperCase();
      const isUpto6      = /UPTO\s*6/.test(st);
      const isSeven10    = /7\s*TO\s*10/.test(st);
      const isCorpBus    = /CORPORATE\s*BUS/.test(st);
      const isSchoolBus  = /SCHOOL\s*BUS/.test(st);
      // 3-wheelers (auto / e-rickshaw) price off their own 3W segments — never
      // these 4W passenger bands. Skip the gate entirely for them.
      const polIsRick = /RIKSHAW|RICKSHAW|E[-\s]?RICK|\b3W\b|TREO|PCV3W?/i
        .test(`${vehicleCategory} ${model}`);
      if (!polIsRick && (isUpto6 || isSeven10 || isCorpBus || isSchoolBus)) {
        // Decide which band the policy wants: 'UPTO6' | 'SEVEN10' | 'CORP'.
        // The operator's own category seat-band "(lo-hi)STR" is the most
        // reliable discriminator and resolves the 7-seat boundary: a
        // "(7-10)STR" Innova is the "7 to 10" band, NOT "Upto 6+1" — even
        // though SEATING_CAPACITY=7 and "6+1" also totals 7. "6+1" means 6
        // passenger seats (+driver), so the seat-number fallback splits at ≤6.
        let want = null;
        const bm = vehicleCategory.match(/\(?\s*(\d+)\s*-\s*(\d+)\s*\)?\s*STR/);
        if (bm) {
          const lo = +bm[1], hi = +bm[2];
          if (lo >= 11)      want = 'CORP';
          else if (lo >= 7)  want = 'SEVEN10';
          else if (hi <= 6)  want = 'UPTO6';
          else               want = 'SEVEN10';   // straddling band (e.g. 4-8) → larger
        } else if (seating != null) {
          if (seating <= 6)       want = 'UPTO6';
          else if (seating <= 10) want = 'SEVEN10';
          else                    want = 'CORP';
        }
        const polIsSchoolBus = /SCHOOL\s*BUS/.test(vehicleCategory);
        const polIsTaxi      = /\bTAXI\b|\bCAB\b/.test(vehicleCategory);
        if (polIsSchoolBus) {
          if (!isSchoolBus) matches = false;                       // school bus → School Bus band only
        } else {
          if (isSchoolBus) matches = false;                        // non-school never takes School Bus
          else if (want === 'UPTO6')   { if (isUpto6)   score += 12; else matches = false; }
          else if (want === 'SEVEN10') { if (isSeven10) score += 12; else matches = false; }
          else if (want === 'CORP')    { if (isCorpBus) score += 12; else matches = false; }
          else if (polIsTaxi) {
            // Seats unknown but clearly a taxi/cab → small passenger vehicle.
            if (isUpto6) score += 12; else if (isCorpBus || isSeven10) matches = false;
          }
          // else: non-taxi PCV with unknown seats → leave to generic scoring.
        }
      }
      // Remark-variant selection on the chosen band (esp. Mumbai "Upto 6+1",
      // filed 3× by remark): kaali-peeli/blue-cab vs regular, NIL DEP vs not,
      // and short-term pro-rata rows.
      if (matches && rule.remarks) {
        const rem = String(rule.remarks).toUpperCase();
        const remOnlyKaali      = /\bONLY\b[\s\S]*KAALI\s*PEELI|\bONLY\b[\s\S]*BLUE\s*CAB/.test(rem);
        const remOtherThanKaali = /OTHER\s*THAN\s*KAALI\s*PEELI/.test(rem);
        const polIsKaaliPeeli   = /KAALI\s*PEELI|BLACK\s*(?:&|AND)?\s*YELLOW|BLUE\s*CAB/i
          .test(`${vehicleCategory} ${model}`);
        if (remOnlyKaali && !polIsKaaliPeeli) matches = false;     // kaali-peeli-only row, regular taxi → drop
        else if (remOtherThanKaali && polIsKaaliPeeli) matches = false;
        // NIL DEP (zero-dep) variant applies only to nil-dep policies.
        if (matches) {
          const remWithNilDep    = /WITH\s+NIL\s*DEP/.test(rem) && !/WITHOUT\s+NIL\s*DEP/.test(rem);
          const remWithoutNilDep = /WITHOUT\s+NIL\s*DEP/.test(rem);
          const polHasNilDep     = params.hasNilDep === true ||
            /NIL\s*DEP|ZERO\s*DEP/i.test(`${params.addonText || ''} ${vehicleCategory}`);
          if (remWithNilDep && !polHasNilDep) matches = false;
          else if (remWithoutNilDep && polHasNilDep) matches = false;
        }
        // Short-term (min 90-day) pro-rata rows apply only to short-term
        // policies; default annual policies drop them.
        if (matches && /SHORT\s*TERM\s*POLICY/.test(rem)) matches = false;
      }
    }

    // Bajaj CAR-SATP make rows are really MODEL rows. Bajaj's "Pvt Car SATP"
    // grid prices the bulk of cars off a make='All' row (e.g. MUMBAI Petrol
    // 0.555, GUJARAT Petrol 0.48) and then files per-MODEL exceptions as
    // make-specific rows whose target model lives ONLY in the remarks:
    //   "VERNA All 40%", "Innova 45%", "Xuv 500 All 40%", "Diesel Swift 25%",
    //   "Ertiga @ IRDA", "Eeco @ IRDA", "Zen 0%", "City 20%", "Beat 5%", ...
    // Because make='Maruti'/'Hyundai'/... out-specifies make='All', a non-listed
    // model (Maruti Vitara, Hyundai Creta, Ford Ecosport, every non-Zen Maruti
    // in Gujarat) wrongly borrowed the listed model's exception rate (2.5/5/0/25)
    // instead of the make='All' headline rate (48/55). Gate the make-specific
    // row by its remark model: keep it only when the policy model carries one of
    // the remark's model tokens; otherwise drop it so the make='All' row wins. A
    // genuine Verna/Innova/Ertiga/Zen still matches its own row. Scoped to Bajaj
    // CAR SATP; the make='All' headline row (whose remark may also list models)
    // is never gated.
    if (matches && rule.insurer === 'bajaj_allianz' &&
        String(rule.product || '').toUpperCase() === 'CAR' &&
        String(rule.rate_type || '').toUpperCase() === 'SATP' &&
        rule.remarks) {
      const mkRaw = String(rule.make || '').trim().toUpperCase();
      const makeSpecific = mkRaw && mkRaw !== 'ALL' && mkRaw !== 'ANY';
      const polModelNS = String(model || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (makeSpecific && polModelNS) {
        const tokens = String(rule.remarks).toUpperCase()
          .replace(/\bCNG\b|\bDIESEL\b|\bPETROL\b|\bLPG\b|\bALL\b|\bIRDA\b|\bMAX\b|\bPO\b|\bJAMMU\b|\bAND\b|\bFOR\b/g, ' ')
          .replace(/\d+\s*%/g, ' ')
          .replace(/[^A-Z0-9]/g, ' ')
          .split(/\s+/)
          .filter((t) => t.length >= 3);
        if (tokens.length > 0 && !tokens.some((t) => polModelNS.includes(t))) {
          matches = false;
        }
      }
    }

    // --- Fuel-bucket preference ---------------------------------------------
    // The SQL lookup deliberately over-fetches on fuel: a "PETROL/CNG" bi-fuel
    // policy expands to BOTH a CNG and a Petrol/"Other Than Diesel" candidate
    // (so a rate is always found even when a card lacks a CNG-specific row).
    // But several cards (e.g. TATA's PCI SATP) price these fuels differently —
    // Diesel/CNG cheaper, Petrol ("Other Than Diesel")/Electric dearer — so we
    // must steer the scorer to the policy's PRIMARY fuel rather than letting an
    // arbitrary candidate win. A factory bi-fuel "PETROL/CNG" (or "BIFUEL" /
    // "PETROL/HYBRID") is a petrol vehicle with a kit; the operator rates it as
    // Petrol → "Other Than Diesel". Pure "CNG"/"LPG" stays in the CNG bucket.
    if (matches && rule.fuel_type) {
      const rf = String(rule.fuel_type).toUpperCase();
      const pf = fuelType; // already upper-cased above
      // Fuel families. Cards (e.g. TATA PCI SATP) split: Diesel & CNG = lower,
      // Petrol("Other Than Diesel") & Electric = higher. The distinction that
      // matters: does the policy fuel contain PETROL?
      //   - "PETROL", "PETROL/CNG" (bi-fuel), "HYBRID", "BIFUEL" → PETROL family
      //     → take the "Other Than Diesel"/Petrol rate (a bi-fuel car is a
      //     petrol vehicle with a kit).
      //   - PURE "CNG"/"LPG" (no petrol)                          → CNG family
      //     → take the CNG-specific rate (NOT the dearer OTD rate); OTD is only
      //     a fallback when the card has no CNG row.
      let primary = '';
      if (/DIESEL/.test(pf)) primary = 'DIESEL';
      else if (/ELECTRIC|BATTERY|\bEV\b/.test(pf)) primary = 'ELECTRIC';
      else if (/PETROL|HYBRID|BIFUEL/.test(pf)) primary = 'PETROL'; // incl. PETROL/CNG bi-fuel
      else if (/CNG|LPG/.test(pf)) primary = 'CNG';                 // pure CNG / LPG
      // Classify the rule's fuel into the same families.
      const rfIsDiesel   = /DIESEL/.test(rf) && !/OTHER\s*THAN/.test(rf);
      const rfIsElectric = /ELECTRIC|BATTERY|\bEV\b/.test(rf);
      const rfIsCng      = /\bCNG\b|\bLPG\b|BIFUEL/.test(rf);
      // "Petrol", "Other Than Diesel", "Others" are the canonical OTD labels.
      const rfIsOtd      = /PETROL/.test(rf) || /OTHER\s*THAN\s*DIESEL/.test(rf) || /^OTHERS?$/.test(rf.trim());
      if (primary === 'DIESEL') {
        if (rfIsDiesel) score += 8; else score -= 6;
      } else if (primary === 'ELECTRIC') {
        if (rfIsElectric) score += 8;
        else if (rfIsOtd) score += 6;            // electric often shares the OTD rate
        else score -= 6;
      } else if (primary === 'PETROL') {
        // Petrol / bi-fuel → "Other Than Diesel"/Petrol rate; CNG row is only a
        // weak fallback; never the Diesel rate.
        if (rfIsOtd) score += 8;
        else if (rfIsElectric) score += 3;
        else if (rfIsCng) score += 4;
        else if (rfIsDiesel) score -= 6;
      } else if (primary === 'CNG') {
        // Pure CNG / LPG → the CNG-specific rate wins; OTD is a fallback only.
        if (rfIsCng) score += 8;
        else if (rfIsOtd) score += 4;
        else if (rfIsDiesel) score -= 6;
      }
    }

    // Corporate vs Individual ownership. PCV bus segments carry a
    // "_Corporate" / "_Individual" suffix that prices the SAME row differently
    // (TATA Delhi PCV bus: Corporate 31% vs Individual 40%). Match the policy's
    // inferred owner type (from the proposer name) so the right bucket wins.
    if (matches) {
      const segCorp = /CORPORATE/.test(seg);
      const segIndiv = /INDIVIDUAL/.test(seg);
      if ((segCorp || segIndiv) && params.ownerType) {
        const ot = String(params.ownerType).toUpperCase();
        if (segCorp && ot === 'CORPORATE') score += 6;
        else if (segIndiv && ot === 'INDIVIDUAL') score += 6;
        else score -= 6;                 // wrong ownership bucket → demote
      }
    }

    // Royal Pvt-Car Comp grid: payout is banded by OD discount, encoded in
    // volume_tier ("Upto 20" / "20-50" / "50-60" / "60-70" / ">70"). Keep only
    // the band that contains the policy's discount % (params.discountPct,
    // sourced from the PR FINALDISCOUNT for Royal in bulk). Boundaries are
    // LOWER-EXCLUSIVE / UPPER-INCLUSIVE — i.e. "60-70" means 61-70 (a 60%
    // discount belongs to "50-60", not "60-70"), confirmed against the operator
    // (MH 60% → "50-60"=0.25, 50% → "20-50"=0.225). The bottom "Upto N" band is
    // inclusive at 0 (0% → "Upto 20"). The open top band ">70" is [N,∞), so an
    // exactly-70 discount matches BOTH "60-70" and ">70"; pickPrimaryRateRule
    // then takes the higher rate (">70"), which is the operator's behaviour
    // (GJ 70% → ">70"=0.26). Fires only for Royal Comp rules carrying a
    // parseable discount-band volume_tier AND when a discount is known — other
    // insurers / numeric volume_tiers (IDV bands) are untouched.
    if (matches && rule.insurer === 'royal_sundaram' && /^COMP$/i.test(rt) &&
        params.discountPct != null) {
      const band = String(rule.volume_tier || '').trim();
      let lo = null, hi = null, mm;
      if ((mm = /^upto\s*(\d+(?:\.\d+)?)$/i.exec(band)))            { lo = 0; hi = parseFloat(mm[1]); }
      else if ((mm = /^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/.exec(band))) { lo = parseFloat(mm[1]); hi = parseFloat(mm[2]); }
      else if ((mm = /^>\s*(\d+(?:\.\d+)?)$/.exec(band)))           { lo = parseFloat(mm[1]); hi = Infinity; }
      if (lo != null) {
        const d = params.discountPct;
        // Lower bound exclusive for the middle bands ("A-B" = 61-70), but
        // inclusive at 0 so a 0% discount still lands in the bottom "Upto" band.
        const lowerOk = lo === 0 ? (d >= lo) : (d > lo);
        let inBand = (hi === Infinity) ? (d >= lo) : (lowerOk && d <= hi);
        // At the exact upper boundary, defer to an open ">hi" band if one
        // exists (70% → ">70", not "60-70"); otherwise the closed band keeps it.
        if (inBand && hi !== Infinity && d === hi && royalOpenBandThresholds.has(hi)) {
          inBand = false;
        }
        if (!inBand) matches = false;
      }
    }

    // IFFCO Tokio PCV volume-premium band default. IFFCO's PCV grid is banded
    // by VOLUME PREMIUM (the agent's premium slab), encoded in volume_tier
    // (Upto 3L, 3L-6L, Above 6L, …) — NOT by IDV. We don't have the volume-
    // premium input, and the variants all share ONE rate_type so byType collapses
    // them arbitrarily (usually to the higher Above-6L / Upto-3L 0.20). Per
    // insurer guidance, for now take the MIDDLE "3L-6L" band for PCV. Steer the
    // scorer (not a hard drop) so a region/segment carrying only other tiers
    // still resolves.
    if (matches && rule.insurer === 'iffco_tokio' &&
        String(params.vehicleType || '').toUpperCase() === 'PCV' && rule.volume_tier) {
      if (/^3\s*L\s*-\s*6\s*L$/i.test(String(rule.volume_tier).trim())) score += 6;
    }

    // Policy-product vs rate_type cross-check:
    //   Comp policy → drop SATP_* and ACT rules (TP-only).
    //   TP   policy → drop COMP_* and PACK rules (Comp-only).
    if (matches) {
      const ip = (params.insProduct || '').toUpperCase();
      // TATA AIG tokens — pipe-delimited "DM|Package|...", "HOM|SATP",
      // "DM|SAOD|...", "DM|NA", "Package_OD", "SAOD_OD", "SATP_TP".
      // Token tests below treat these as Comp / TP / SAOD respectively.
      const tataIsTp   = /\|SATP\b|^SATP_TP$|^(DM|HOM)\|NA$/i.test(rt);
      const tataIsSaod = /\|SAOD\b|^SAOD_OD\b/i.test(rt);
      const tataIsComp = /\|Package\b|^Package_OD\b/i.test(rt);
      if (ip === 'COMP') {
        if (/^SATP([_\s]|$)/.test(rt)) { if (!allowAgedSatpFallback) matches = false; }
        else if (/^ACT([_\s]|$)/.test(rt)) matches = false;
        else if (tataIsTp || tataIsSaod) matches = false;
      } else if (ip === 'TP') {
        // Flat-rate Comp-as-TP exception: several insurers quote one
        // Comp rate that covers both OD and TP (UII, Kotak TW Rest Grid,
        // IFFCO Tokio). Two heuristics:
        //   (a) Plain TW family segment with bare COMP rate_type.
        //   (b) Rule's remarks explicitly say "applies to OD & TP" or
        //       "applies to OD and TP" (UII grid uses this verbiage).
        // When either holds, don't hard-drop for a TP policy.
        const isTwCompFlat =
          /^(TW|2W)(\s+(BIKE|SCOOTER|MOTORCYCLE|EV))?$/i.test(rule.segment || '')
          && /^COMP$/i.test(rt);
        const isRemarkOdAndTp =
          /^COMP$/i.test(rt)
          && /\bapplies?\s+to\s+OD\s*(&|and)\s*TP\b/i.test(String(rule.remarks || ''));
        // Commercial-vehicle flat rate: Universal Sompo computes GCV / PCV /
        // MISC commission on NET premium (OD+TP combined) and ships a single
        // bare-COMP column per segment with NO separate SATP. So that COMP
        // rate applies to a TP-only policy too. Scoped to US because other
        // commercial insurers (Bajaj, Magma, …) DO split COMP vs SATP — for
        // them a TP policy must keep using SATP, so bare COMP stays dropped.
        const policyVtCv = String(params.vehicleType || '').toUpperCase();
        const isCommercialCompFlat =
          rule.insurer === 'universal_sompo'
          && (policyVtCv === 'GCV' || policyVtCv === 'PCV' || policyVtCv === 'MISC')
          && /^COMP$/i.test(rt);
        if (isTwCompFlat || isRemarkOdAndTp || isCommercialCompFlat) {
          // keep — rate applies to TP too
        }
        else if (/^COMP([_\s]|$)/.test(rt)) matches = false;
        else if (/^PACK([_\s]|$)/.test(rt)) matches = false;
        // Royal Pvt-Car standalone-TP ("PC STP") is a single SATP rate split by
        // FUEL × CC band, NOT an ACT/PACK split: the parser mislabeled the sheet's
        // DIESEL columns as SATP_ACT and the "Non Diesel" columns as SATP_PACK.
        // Select the column by the policy's fuel — Diesel → SATP_ACT, everything
        // else (petrol / CNG / LPG / EV / blank) → SATP_PACK. Scoped to Royal CAR
        // so genuine ACT/PACK TP grids at other insurers are untouched. (Verified:
        // petrol Eeco/Dzire/Xcent → "Non Diesel" col = operator rate; diesel Indigo
        // eCS → "Diesel" col = operator rate.)
        else if (rule.insurer === 'royal_sundaram' &&
                 String(params.vehicleType || '').toUpperCase() === 'CAR' &&
                 /^SATP_(ACT|PACK)$/i.test(rt)) {
          const isDiesel = /DIESEL/i.test(String(params.fuelType || ''));
          if (isDiesel && /^SATP_PACK$/i.test(rt)) matches = false;        // diesel → drop Non-Diesel col
          else if (!isDiesel && /^SATP_ACT$/i.test(rt)) matches = false;   // non-diesel → drop Diesel col
        }
        // Bundled-Comp tenure-prefixed rate types (Digit / ICICI style):
        // "1+1_MAX_CD2", "1+3_MAX_CD2", "1+5_MAX_CD2", "2+2_MAX_CD2",
        // "3+3_MAX_CD2", "5+5_MAX_CD2".  These are all Comp products
        // bundled with TP — a pure TP policy must not match them.
        else if (/^\d\+\d([_\s]|$)/.test(rt)) matches = false;
        // Chola TW Comp rate_types — drop for pure TP policies.
        else if (/^NEW\(/i.test(rt)) matches = false;
        else if (/^ANNUAL$/i.test(rt)) matches = false;
        else if (tataIsComp || tataIsSaod) matches = false;
      } else if (ip === 'SAOD') {
        // SAOD policy → drop pure TP and bundled-Comp rules; keep SAOD_*
        // rate types.
        if (/^SATP([_\s]|$)/.test(rt)) matches = false;
        else if (/^ACT([_\s]|$)/.test(rt)) matches = false;
        else if (/^\bTP\b/.test(rt))      matches = false;
        // Bundled-Comp tenure rate types (Digit TW: "1+1_MAX_CD2",
        // "1+5_MAX_CD2", "5+5_MAX_CD2") are Comp-with-TP, NOT SAOD. Drop them
        // so a SAOD policy falls through to the SAOD-specific rate (Digit's
        // "TW SAOD with Flexi" grid, rate_type "SAOD"). The SAOD-as-Comp
        // retry still covers SAOD policies that genuinely have no SAOD rule.
        else if (/^\d\+\d([_\s]|$)/.test(rt)) matches = false;
        else if (tataIsTp || tataIsComp) matches = false;
      }
    }

    // Business-type filter — don't match "New Business" sheets for Renewal / Rollover
    // policies (or a 5-year-old vehicle).
    if (matches) {
      const sheetIsNew = /new\s*business/i.test(rule.sheet_name || '');
      const bt = (params.businessType || '').toUpperCase();
      const isRenewalOrRollover = bt === 'RENEWAL' || bt === 'ROLLOVER';
      if (sheetIsNew && isRenewalOrRollover) matches = false;
      // Extra safety: if vehicleAge >= 1 and sheet is "New Business", it can't apply
      if (matches && sheetIsNew && (params.vehicleAge || 0) >= 1) matches = false;
    }

    // Tenure/business sub_type gating. TATA (and others) encode the business
    // tenure in sub_type — "Brand New" / "Renewal" / "Rollover" — and price
    // them differently (e.g. ROM2 Motor Cycle SATP: Brand New 26.5% vs
    // Renewal/Rollover 28.5%). A vehicle aged >= 1 year cannot be "Brand New";
    // a brand-new (age 0) vehicle is Brand New, not a Renewal/Rollover. Steer
    // the scorer rather than hard-dropping, so a grid that only carries one
    // tenure variant still resolves (no new No-Rule).
    if (matches && rule.sub_type) {
      const st = String(rule.sub_type);
      const ruleBrandNew = /brand\s*new/i.test(st);
      const ruleRenewal  = /renew/i.test(st);
      const ruleRollover = /roll\s*over/i.test(st);
      if (ruleBrandNew || ruleRenewal || ruleRollover) {
        const age = params.vehicleAge;
        const bt = (params.businessType || '').toUpperCase();
        if (age != null && age >= 1) {
          if (ruleBrandNew) score -= 15;     // aged vehicle is NOT Brand New
          else score += 6;                    // Renewal/Rollover fits an aged vehicle
          if (bt === 'ROLLOVER' && ruleRollover) score += 3;       // exact tenure match
          else if (bt === 'RENEWAL' && ruleRenewal) score += 3;
        } else if (age === 0) {
          if (ruleBrandNew) score += 6;       // age 0 → Brand New
          else score -= 10;                   // a new vehicle isn't Renewal/Rollover
        }
      }
    }

    // If rate_type carries a make bucket suffix (CD2_Kia, CD2_Others, CD2_HEV),
    // require it to match this policy's bucket.
    if (matches && rtBucket) {
      if (policyBucket) {
        // Policy is in a specific bucket → only that bucket (or generic Others as fallback)
        if (rtBucket === policyBucket) score += 8;
        else if (rtBucket === 'Others') score += 1; // generic fallback, low priority
        else matches = false;
      } else {
        // Policy make not in any listed bucket → use the fallback (HEV for high-end else Others)
        if (rtBucket === policyBucketFallback) score += 5;
        else if (rtBucket === 'Others' && !isHighEnd) score += 3;
        else matches = false;
      }
    }

    // State filter via rule.remarks — Royal Sundaram (and similar tier-card
    // insurers) ship per-state Comp rates in tier regions, with the state
    // name written into `remarks`. When `remarks` is non-empty AND looks
    // like a state name, require it to match the policy state. Empty
    // remarks = wildcard.
    //
    // HDFC Ergo / ICICI Lombard exception: their rate cards encode the
    // geographic split in the `region` column (Mumbai / Delhi NCR / NCR /
    // KOLKATA / etc.). For SPECIFIC regions, the `remarks` column is
    // descriptive metadata that often repeats the region name — checking
    // it against the policy's RTO state would wrongly reject cross-state
    // policies (e.g. registered in Bihar but booked from Delhi NCR).
    //
    // BUT: HDFC's PCV grid uses generic regions like "All RTOs" with the
    // state name in `remarks` (Bihar / Jharkhand / Assam / …). For these
    // generic regions, the remarks IS the state discriminator and must be
    // honored — otherwise a Jharkhand policy would match a Bihar rule.
    // Universal Sompo uses cluster-region rules (DL-NCR / RJ-1 / UP-1 / GJ-DD)
    // with the state name in `remarks` as descriptive metadata. The cluster
    // already encodes the geographic gating (DL-NCR includes Delhi + parts of
    // Haryana / UP / Uttarakhand), so applying the remarks-state filter would
    // wrongly reject a Ghaziabad (UP14) policy against a DELHI-remarks rule.
    const isClusterRegion = (r) => /^(DL-NCR|RJ-\d|UP-\d|GJ\/DD|J&K\/LA)$/i.test(String(r || ''));
    const skipRemarksState =
      ((rule.insurer === 'hdfc_ergo' || rule.insurer === 'icici_lombard')
       && !isHdfcGenericRegion(rule.region))
      || (rule.insurer === 'universal_sompo' && isClusterRegion(rule.region))
      // Magma uses cluster-coded regions for every rule (GJ1/GJ2, HR1/HR2,
      // UP1-UP8, MP1-MP14, etc.). The remarks column carries a descriptive
      // "(StateName)" suffix that doesn't always match the policy's RTO
      // state — e.g. DD (Dadra) RTOs map to cluster GJ1 (Gujarat). The
      // cluster→region mapping in rto_mappings already encodes the
      // geographic gating, so the remarks-state check would wrongly
      // reject cross-state cluster placements.
      || (rule.insurer === 'magma_hdi');
    if (matches && !skipRemarksState && rule.remarks && policyStateFull) {
      const rem = String(rule.remarks).toUpperCase();
      const looksLikeStateRemark = /\b(MAHARASHTRA|GUJARAT|KARNATAKA|TAMIL\s*NADU|KERALA|ANDHRA|TELANGANA|PUNJAB|HARYANA|DELHI|RAJASTHAN|UTTAR\s*PRADESH|BIHAR|JHARKHAND|ODISHA|ORISSA|WEST\s*BENGAL|MADHYA\s*PRADESH|CHHATTISGARH|UTTARAKHAND|HIMACHAL|JAMMU|KASHMIR|GOA|ASSAM|MEGHALAYA|MIZORAM|MANIPUR|NAGALAND|TRIPURA|SIKKIM|ARUNACHAL|DELHI\s*-\s*NCR|NCR)\b/.test(rem);
      if (looksLikeStateRemark) {
        // Bidirectional token match — try policy-state tokens against remarks
        // AND remarks tokens against policy state. Handles compound remarks
        // ("Delhi-NCR", "Maharashtra, Gujarat") as well as compound state
        // names like "Andhra Pradesh".  Also expand a few common aliases:
        // "NCR" covers DELHI / parts of HARYANA / UTTAR PRADESH; "Delhi-NCR"
        // is equivalent to DELHI for matching purposes.
        const STATE_ALIASES = {
          'DELHI': ['DELHI', 'NCR'],
          'HARYANA': ['HARYANA', 'NCR'],     // Gurgaon / Faridabad sit in NCR
          'UTTAR PRADESH': ['UTTAR', 'PRADESH', 'UP', 'NCR'],  // Noida / Ghaziabad in NCR
          'TAMIL NADU': ['TAMIL', 'NADU', 'TN'],
          'ANDHRA PRADESH': ['ANDHRA', 'PRADESH', 'AP'],
          'MADHYA PRADESH': ['MADHYA', 'PRADESH', 'MP'],
          'WEST BENGAL': ['WEST', 'BENGAL', 'WB'],
          'JAMMU & KASHMIR': ['JAMMU', 'KASHMIR', 'J&K', 'JK'],
          'JAMMU AND KASHMIR': ['JAMMU', 'KASHMIR', 'J&K', 'JK'],
        };
        const policyStateTokens = (STATE_ALIASES[policyStateFull] ||
                                   policyStateFull.split(/[\s,/&-]+/).filter(t => t.length >= 2));
        const remTokens = rem.split(/[\s,/&-]+/).filter(t => t.length >= 2);
        const remarkContainsState =
          policyStateTokens.some(t => rem.includes(t)) ||
          remTokens.some(t => policyStateFull.includes(t));
        if (!remarkContainsState) matches = false;
        else score += 4; // state-specific match
      }
    }

    // --- Range checks against rate_rules schema columns ---
    // Only narrow when the policy has a known value.

    // CC band — apply a small tolerance on boundaries because rate cards
    // frequently encode "Bike <150CC" / "<=1000CC" as cc_band_max=149 / =999
    // while the policy reports cc=150 / =1000 (off by one). Hard-rejecting
    // these sees a ~1% rate-card-edge mismatch land at No-Rule. Allow up to
    // 5cc slack on each side; still drops policies that genuinely fall well
    // outside the band.
    //
    // Royal Sundaram exception: Royal TW segments labelled "Scooter (1+1)
    // Rollover" / "Bike <150CC Rollover (no EV)" are *generic* bike/scooter
    // categories — the CC qualifier on "Bike <150CC" is a sheet artefact and
    // the rule applies to all CC values. Skip the cc_band check for Royal TW
    // bike/scooter segments.
    const isRoyalGenericTw =
      (rule.insurer === 'royal_sundaram' && /^(SCOOTER|BIKE)\b/i.test(rule.segment || ''));
    if (matches && !isRoyalGenericTw && cc != null && (rule.cc_band_min != null || rule.cc_band_max != null)) {
      const ccMinSlack = (rule.cc_band_min != null) ? Math.max(0, rule.cc_band_min - 5) : null;
      const ccMaxSlack = (rule.cc_band_max != null) ? rule.cc_band_max + 5 : null;
      if (ccMinSlack != null && cc < ccMinSlack) matches = false;
      if (matches && ccMaxSlack != null && cc > ccMaxSlack) matches = false;
      if (matches) {
        // Tight (strictly within the band) vs slack-only (matched only via the
        // ±5cc edge tolerance) — a strict containment scores higher so that,
        // when a cc near a band boundary edge-matches two ADJACENT bands
        // (e.g. a 155cc bike vs both "Upto 150" [max 150] and "150-350"
        // [min 150]), the band that truly contains it wins. The slack still
        // rescues a lone off-by-one card-edge match (no competing tight band).
        const tight =
          (rule.cc_band_min == null || cc >= rule.cc_band_min) &&
          (rule.cc_band_max == null || cc <= rule.cc_band_max);
        score += tight ? 3 : 1;
      }
    }

    // Seating capacity band
    // Royal Sundaram exception: their "3W PCV Auto 0-3 Seater" segment is a
    // generic 3W PCV passenger-auto category — the seater label is a sheet
    // artefact, not a real cap. Skip seating check for these segments so
    // 4-5-seater electric autos (KineticGreen Safar, Daksh Ronak, Panther,
    // Arzoo, Dilli Electric, etc.) match.
    const isRoyalGenericPcv3w =
      (rule.insurer === 'royal_sundaram' && /3W\s*PCV|PCV\s*AUTO/i.test(rule.segment || ''));
    if (matches && !isRoyalGenericPcv3w && seating != null && (rule.seating_capacity_min != null || rule.seating_capacity_max != null)) {
      if (rule.seating_capacity_min != null && seating < rule.seating_capacity_min) matches = false;
      if (matches && rule.seating_capacity_max != null && seating > rule.seating_capacity_max) matches = false;
      if (matches) score += 3;
    }

    // Tonnage (weight_band is in tonnes) — skipped entirely for MISC
    // policies (tractors / construction equipment / harvesters): tonnage
    // isn't meaningful for these and source data rarely populates it, so
    // any weight-band filter trivially excludes the right rule.
    const policyIsMiscType = String(params.vehicleType || '').toUpperCase() === 'MISC';
    if (matches && !policyIsMiscType && tonnage != null && (rule.weight_band_min != null || rule.weight_band_max != null)) {
      if (rule.weight_band_min != null && tonnage < parseFloat(rule.weight_band_min)) matches = false;
      if (matches && rule.weight_band_max != null && tonnage > parseFloat(rule.weight_band_max)) matches = false;
      if (matches) score += 3;
    }

    // Tonnage range encoded in segment text — e.g. "GCV4 2.5 To 3.5T",
    // "GCV4 upto 2.5T", "GCV4 44T+". Match when policy tonnage fits.
    // Skipped for MISC (see above).
    if (matches && !policyIsMiscType && (tonnage != null || (params.tonnageMin != null && params.tonnageMax != null))) {
      const segTonRange = extractSegmentTonnageRange(seg);
      if (segTonRange) {
        const policyLo = params.tonnageMin != null ? params.tonnageMin : tonnage;
        const policyHi = params.tonnageMax != null ? params.tonnageMax : tonnage;
        const overlaps = !(policyHi < segTonRange.min || policyLo > segTonRange.max);
        if (!overlaps) matches = false;
        else score += 5;
      }
    }

    // Vehicle age band (redundant with SQL filter but defends against unbounded rows)
    if (matches && params.vehicleAge != null && (rule.vehicle_age_min != null || rule.vehicle_age_max != null)) {
      if (rule.vehicle_age_min != null && params.vehicleAge < rule.vehicle_age_min) matches = false;
      if (matches && rule.vehicle_age_max != null && params.vehicleAge > rule.vehicle_age_max) matches = false;
    }

    // Addon flag — when a rule is explicitly conditioned on add-on status
    // (rule.addon = Y/Yes/1 = "with add-on" rate, or N/No/0 = "without
    // add-on" rate), it must MATCH the policy's add-on status. Universal
    // Sompo's Pvt Car grid, for example, ships a separate "without add-on"
    // rate (e.g. 21% for >5yr) tagged addon='N' that must NOT apply to a
    // policy that actually carries add-on premium. Hard-drop on conflict;
    // a blank rule.addon stays a wildcard (applies to both).
    if (matches && rule.addon != null && String(rule.addon).trim() !== '') {
      const ruleAddon = String(rule.addon).toLowerCase().trim();
      const ruleWantsAddon =
        ruleAddon === 'y' || ruleAddon === 'yes' || ruleAddon === 'true' || ruleAddon === '1';
      const ruleWantsNoAddon =
        ruleAddon === 'n' || ruleAddon === 'no' || ruleAddon === 'false' || ruleAddon === '0';
      if (ruleWantsAddon || ruleWantsNoAddon) {
        const want = ruleWantsAddon;       // true = rule is the WITH-addon rate
        if (want === policyHasAddon) {
          score += 4;                      // exact add-on match
          // ">5 yr without add-on" OVERLAY: Universal Sompo (and similar)
          // ship a special lower net-premium rate for old (age>5) vehicles
          // with no add-on. It OVERRIDES the standard NCB Package rate when
          // it applies, so boost it past the NCB band score (+8) to win the
          // same-rate_type dedup.
          if (/without\s*add[\s-]?on/i.test(String(rule.remarks || ''))) score += 15;
        }
        else matches = false;                      // conflict → drop
      }
    }

    // Carrier type (GCV body type)
    if (matches && carrier && rule.carrier_type) {
      const rc = String(rule.carrier_type).toUpperCase();
      if (rc === carrier || rc.includes(carrier) || carrier.includes(rc)) score += 2;
      // don't hard-fail — carrier text is inconsistent
    }

    // TW segment vehicle-type tokens are OR'd across the slash:
    //   "SC/EV"   = Scooter OR Electric bike
    //   "MC/EV"   = Motorcycle OR Electric bike
    //   "SC"      = Scooter only
    //   "EV"      = Electric vehicle only
    // A rule matches if ANY token applies to the policy.
    const policyIsEv = fuelType.includes('EV') || fuelType.includes('ELECTRIC');

    // Known scooter / motorcycle model keywords — used when vehicleCategory is
    // generic (e.g. "Two Wheeler") and we need to disambiguate from the model.
    const SCOOTER_MODELS = /ACTIVA|JUPITER|FASCINO|ACCESS|DIO|BURGMAN|NTORQ|MAESTRO|AVIATOR|PLEASURE|VESPA|SCOOTY|DESTINI|XOOM|RAY|ALPHA|ZR|ELECTRIC\s*SCOOTER|CHETAK|IQUBE|OLA\s+S\d/i;
    const BIKE_MODELS = /PULSAR|SPLENDOR|PASSION|DISCOVER|APACHE|UNICORN|SHINE|HORNET|AVENGER|DUKE|NINJA|THUNDER|BULLET|CLASSIC|MAVRICK|GIXXER|FZ\b|R15|YZF|MT\d|CB\s|CBR|CBZ|XPULSE|HIMALAYAN|METEOR|INTERCEPTOR|CONTINENTAL|SCRAM|RAIDER|RAGING|GLAMOUR|SP\s*125|STAR\s*CITY|RADEON|XTREME|FREEDOM|RTR/i;

    const modelIsScooter = SCOOTER_MODELS.test(model);
    const modelIsBike    = BIKE_MODELS.test(model);
    const catIsScooter   = /SCOOTY|SCOOTER|TW\s*-\s*SCOO/i.test(vehicleCategory);
    const catIsBike      = /MOTORCYCLE|MOTOR[\s_]*CYCLE|\bMC\b|\bBIKE\b/i.test(vehicleCategory);
    let policyIsScooter, policyIsBike;
    if (rule.insurer === 'shriram' && (catIsScooter || catIsBike)) {
      // Shriram pays per the SOURCE category's Bike / Scooter / Moped label —
      // its TW grid has 3 distinct rates (e.g. Gujarat: Bike 38, Scooter 45,
      // Moped 45). The operator honours the source category even when it
      // mislabels a scooter-shaped model as "Bike" (e.g. Hero Destini filed as
      // "TW - Bike" → paid the 38 Bike rate, not 45 Scooter). So trust the
      // category token OVER the model-name heuristic here, reversing the usual
      // model-wins rule, so our rate matches the operator's statement.
      policyIsScooter = catIsScooter;
      policyIsBike    = catIsBike && !catIsScooter;
    } else {
      // The source's vehicleCategory frequently mislabels motorcycles as
      // "Scooter" (e.g. a TVS Raider — a 125cc bike — comes through as SCOOTER).
      // The MODEL is the more reliable signal: when it's a known bike/scooter,
      // trust it OVER a conflicting category. Fall back to the category only
      // when the model isn't in either list.
      policyIsScooter = modelIsScooter || (catIsScooter && !modelIsBike);
      policyIsBike    = modelIsBike    || (catIsBike    && !modelIsScooter);
    }

    // Does the segment explicitly list one of these TW subtype tokens?
    const segHasSc = /(^|[\s/_\-])SC([\s/_\-]|$)|SCOOTER/i.test(seg);
    const segHasEv = /(^|[\s/_\-])EV([\s/_\-]|$)|ELECTRIC/i.test(seg);
    const segHasMc = /(^|[\s/_\-])MC([\s/_\-]|$)|MOTOR\s*CYCLE|\bBIKE\b/i.test(seg);

    if (segHasSc || segHasEv || segHasMc) {
      // OR-match: rule is applicable if any listed token matches the policy's
      // vehicle sub-type / fuel.
      let twTokenMatch = false;
      if (segHasSc && policyIsScooter) { twTokenMatch = true; score += 3; }
      if (segHasEv && policyIsEv)      { twTokenMatch = true; score += 3; }
      if (segHasMc && policyIsBike)    { twTokenMatch = true; score += 3; }
      // SC vs SC_EV fuel split: an "SC_EV" / "SC EV" segment (the Flexi grid's
      // electric-scooter row) is EV-specific. A PETROL scooter must take plain
      // "SC", and an EV scooter must take "SC_EV". Demote the wrong fuel
      // variant so the right one wins. ("SC/EV" with a slash is a combined
      // scooter-or-EV label, not a fuel split — left untouched.)
      const segIsEvScooterVariant = /\bSC[_\s]+EV\b|SCOOTER[_\s]+EV/i.test(seg);
      if (policyIsScooter) {
        if (segIsEvScooterVariant && !policyIsEv) score -= 6;        // EV-only rate, petrol scooter
        else if (segHasSc && !segHasEv && policyIsEv) score -= 6;    // petrol rate, EV scooter
      }
      // Disambiguation fallback: when the policy's sub-type couldn't be
      // determined (model not in our SCOOTER_MODELS / BIKE_MODELS lists,
      // category just "Two Wheeler"), don't hard-drop — let the rule pass
      // with no score bonus.  Keeps real-world models like "Xtreme 125R"
      // from disappearing because they're absent from a hardcoded list.
      const policyDisambiguated = policyIsScooter || policyIsBike || policyIsEv;
      // Generic-EV exception: when only `policyIsEv` is true (model isn't in
      // either Scooter or Bike list — e.g. BGAUSS C12i, Ather, Ola S1) and
      // the rate card carries only Bike/Scooter segments without EV variants,
      // accept whichever is closest rather than dropping every rule. ICICI
      // ships only "TW Bike Comp 1+1 Old" / "TW Scooter Comp 1+1 Old" — both
      // were previously dropped for any unlisted EV model.
      const genericEv = policyIsEv && !policyIsScooter && !policyIsBike;
      // Royal Sundaram TW exception: per insurer's confirmed semantics, all
      // TW rules apply to all bikes & scooters regardless of segment label
      // ("Bike" / "Scooter" are display tags, not real restrictions). Don't
      // hard-drop a Bike rule for a scooter or vice versa.
      if (!twTokenMatch && policyDisambiguated && !genericEv && !isRoyalGenericTw) matches = false;
    }

    // CC-based segment matching for TW
    // Skip for Royal generic Bike/Scooter segments (CC qualifier is a label,
    // not a real restriction — see comment above on isRoyalGenericTw).
    if (cc && matches && !isRoyalGenericTw) {
      if (seg.includes('<=') || seg.includes('< ')) {
        // e.g. "MC <= 180"
        const ccMatch = seg.match(/(\d+)/);
        if (ccMatch) {
          const maxCC = parseInt(ccMatch[0], 10);
          if (cc <= maxCC) score += 5;
          else matches = false;
        }
      } else if (seg.includes('>')) {
        // e.g. "MC>350"
        const ccMatch = seg.match(/>(\d+)/);
        if (ccMatch) {
          const minCC = parseInt(ccMatch[1], 10);
          if (cc > minCC) score += 5;
          else matches = false;
        }
      } else if (seg.match(/(\d+)\s*[-_]\s*(\d+)/)) {
        // e.g. "MC_180-350"
        const rangeMatch = seg.match(/(\d+)\s*[-_]\s*(\d+)/);
        if (rangeMatch) {
          const minCC = parseInt(rangeMatch[1], 10);
          const maxCC = parseInt(rangeMatch[2], 10);
          if (cc >= minCC && cc <= maxCC) score += 5;
          else matches = false;
        }
      }
    }

    // Segment-based make matching — hard drop when the segment explicitly lists
    // makes and the policy's make isn't one of them (and isn't "Others").
    if (make && matches) {
      const primaryMake = make.split(/\s+/)[0];
      const KNOWN_MAKES = ['HERO', 'HONDA', 'TVS', 'SUZUKI', 'YAMAHA', 'RE',
        'ROYAL ENFIELD', 'BAJAJ', 'KTM', 'JAWA', 'AVENGER',
        'TATA', 'MAHINDRA', 'KIA', 'HYUNDAI', 'TOYOTA', 'MARUTI', 'MG',
        'SKODA', 'VOLKSWAGEN', 'VOLKS', 'FORD', 'NISSAN', 'RENAULT', 'BMW',
        'MERCEDES', 'AUDI', 'JAGUAR', 'LAND ROVER', 'PORSCHE', 'VOLVO'];
      // Make aliases: rate cards abbreviate some makes (Digit's TW SATP grid
      // uses "_RE" for Royal Enfield). Recognise the abbreviation as an
      // explicit make match so a Royal Enfield policy picks "MC_180-350_RE"
      // (45%) over the "Others" / "Honda/Jawa/Avenger" buckets. The token is
      // matched as a whole word/suffix so it doesn't false-hit RENAULT etc.
      const policyIsRE = /ROYAL\s*ENFIELD/.test(make) || make === 'RE';
      const segIsRE = /(?:^|[_\s/-])RE(?:$|[_\s/-])/.test(seg);
      const segHasOurMake = seg.includes(primaryMake) || seg.includes(make)
        || (policyIsRE && segIsRE);
      const segHasOthers = /\bOTHERS?\b/.test(seg);
      const segLists = KNOWN_MAKES.some(m => seg.includes(m));

      if (segHasOurMake) {
        score += 10; // explicit match (Hero rule for Hero policy etc.)
      } else if (segLists && !segHasOthers) {
        // Segment lists specific makes but ours isn't in it.
        // Per user's "OR-based" rule: don't hard drop — just score lower
        // so that an "Others"/wildcard rule for the same rate_type wins
        // the dedup.  E.g. for a Bajaj policy in a region with both
        // "MC <= 180 Hero/Honda" and "MC <= 180 Others" rules: Hero/Honda
        // gets score 0 here, Others gets +5 below — Others wins.
        // Hero/Honda survives only if no Others variant exists.
      } else if (segHasOthers) {
        score += 5; // raised from +1 — Others is the canonical fallback
                    // when policy make isn't explicitly named in segment.
      }
    }

    // Vehicle-category matching from segment text — two layers:
    //
    //  (a) Exclusive  : segment declares a category the policy isn't → drop.
    //  (b) Required   : for a commercial-passenger policy, the rule's segment
    //                   must carry a matching vehicle-type keyword (E-Rickshaw,
    //                   Taxi, PCV3W, Bus, etc.). A plain state-only segment
    //                   (e.g. "Uttar Pradesh") doesn't identify the vehicle,
    //                   so it's treated as implicit-bus and requires a bus
    //                   policy to match.
    if (matches) {
      const CAT_KEYWORDS = {
        // ICICI uses "PCVTAXI<=1000CC" / "PCVTAXI>1000CC" without a separator
        // before TAXI — \bTAXI fails because the preceding "V" is a word char.
        // Match TAXI as a suffix (TAXI\b) too so these segments are recognised
        // as the PCV-Taxi family. Substring collisions on rare strings like
        // "MAXITAXI" are still legitimately taxi rules.
        TAXI:     /TAXI\b|\bMAXI\s*CAB\b|\bBIG\s*TAXI/i,
        BUS:      /\bSCHOOL\s*BUS\b|\bSTAFF\s*BUS\b|\bBUS\b/i,
        // "TRAC[" matches Chola's "1_TRAC[NEW]" / "1_TRAC[RENEWAL]" segments
        // for tractors (stored in GCV grid). \b TRAC \b does not match
        // because the leading "_" is a word character — anchor on the
        // trailing "[" instead, which only appears in the tractor variant.
        TRACTOR:  /\bTRACTOR\b|\bHARVESTOR\b|\bHARVESTER\b|TRAC\[/i,
        // RICKSHAW also matches Digit-style GCV3 / PCV3 (3-wheeler) segments
        // that drop the trailing "W". Without this, a 3-wheeler GCV policy
        // (vehicleCategory "GCV - 3W") rejects all "GCV3" rules and lands at
        // No-Rule even when Delhi has perfectly applicable GCV3 rates.
        // Chola uses "GCCV_3W" (Good Cargo Carrying Vehicle - 3 Wheeler) for
        // 3-wheeler goods carriers like Euler / Mahindra Treo Zor / Bajaj
        // Maxima Cargo. \b doesn't fire between `_` and `G` (both are word
        // chars), so we anchor GCCV without a leading word boundary — the
        // token is distinctive enough that substring collisions aren't a
        // real concern.
        // NB: 3-wheeler tokens must NOT match tonnage-band segments like
        // "GCV 3.5T - 7.5T" (4-wheeler 5.5T truck) where the digit "3" sits
        // in a decimal tonnage. Require either an explicit "W" suffix after
        // the 3, or a digit-3 that is NOT followed by a "." or another
        // digit (the (?![.\d]) negative-lookahead guards against capturing
        // "3.5T" or "30T").
        RICKSHAW: /E[-\s]?RIKSHAW|E[-\s]?RICKSHAW|\bRICKSHAW\b|\bAUTO\s*RICKSHAW\b|\bPCV3W?\b|\b3W\b|\b3\s*WHEELER\b|\bTHREE\s*WHEELER\b|\bGCV3W?\b(?![.\d])|\bGCV\s*3W\b|\bGCV\s*3(?![.\d])|GCCV[\s_-]*3W?\b|GCCV3\b|\bPCV\s*AUTO\b|\bPCV\s*[\dN].*SEATER\b/i,
      };

      const policyIsPvtCar = vehicleCategory.includes('PVT') || vehicleCategory.includes('PRIVATE') ||
                             vehicleCategory === 'CAR' || /PVT\.?\s*CAR/i.test(vehicleCategory);
      const policyIsTaxi = /\bTAXI\b/i.test(vehicleCategory);
      const policyIsBus = /\bBUS\b/i.test(vehicleCategory);
      // Route-permit / stage-carriage passenger buses are a DECLINED class for
      // the operator (no payout). These are NOT taxis: the source occasionally
      // ships a Tavera/Innova-style 8-seater under "Route Bus", but unlike a
      // "PCV-TAXI" category the operator does not pay them. Detect the explicit
      // route/stage-carriage label and hard-drop every segment below so the
      // policy lands no-rule, matching the operator's decline. Must NOT match
      // "School Bus" / "Staff Bus" (which the operator does pay).
      const policyIsRouteBus = /\bROUTE\s*BUS\b|\bSTAGE\s*CARR?IAGE\b|\bCONTRACT\s*CARR?IAGE\b/i.test(vehicleCategory);
      // Tractor detection. vehicleCategory is often blank for tractors (they
      // arrive as vehicleType=MISC with only make/model). Recognise the word
      // TRACTOR in category or model, and — for a MISC-type policy — a known
      // tractor manufacturer. The MISC gate keeps make-matching safe: a
      // Mahindra/Force/Eicher CAR or truck is typed CAR/GCV, never MISC, so a
      // MISC + tractor-make policy is reliably an agricultural tractor.
      const TRACTOR_MAKES = /MAHINDRA|SONALIKA|SWARAJ|JOHN\s*DEERE|MASSEY|FERGUSON|NEW\s*HOLLAND|EICHER|ESCORT|KUBOTA|FARMTRAC|POWER\s*TRAC|POWERTRAC|INDO\s*FARM|PREET|\bVST\b|SAME\s*DEUTZ|DEUTZ|\bTAFE\b|INTERNATIONAL\s*TRACTOR|SOLIS|CAPTAIN|FORCE\s*ORCHARD/i;
      // Ambiguous makes (Mahindra, Eicher, Escort) also build construction
      // equipment and trucks that are typed MISC. Exclude those by model
      // keyword so make-based detection doesn't misroute e.g. Mahindra "Earth
      // Master" (backhoe), "Truxo" (pickup) or Eicher "Pro 6028" (truck) to
      // the tractor rate.
      const NON_TRACTOR_MISC = /EARTH\s*MASTER|BACKHOE|\bLOADER\b|\bJCB\b|EXCAVATOR|\bCRANE\b|DOZER|DUMPER|TIPPER|FORKLIFT|\bTRUXO\b|\bPRO\s*\d|\bDOST\b|GRADER|ROLLER|\bPAVER\b|COMPACTOR/i;
      const policyIsTractor = /\bTRACTOR\b/i.test(vehicleCategory) ||
        /\bTRACTOR\b/i.test(model) ||
        (policyIsMiscType && TRACTOR_MAKES.test(`${make} ${model}`) &&
          !NON_TRACTOR_MISC.test(`${make} ${model} ${vehicleCategory}`));
      const policyIsRickshaw = /RIKSHAW|RICKSHAW|E[-\s]?RICK|E[-\s]?RIK|\b3W\b|TREO|PCV3W?/i.test(vehicleCategory + ' ' + model);

      // (a) Exclusive drops — rule segment declares non-matching category.
      //
      // For PCV policies, Taxi/Bus/Rickshaw all sit under the same product
      // family — source data often misclassifies a Tavera/Aura/EECO as
      // "Route Bus" or leaves vehicleCategory blank, but the rule's Taxi
      // segment is still applicable.  Only hard-drop when the policy is
      // clearly a different vehicleType (TW, GCV, CAR private).
      const policyIsPcv = String(params.vehicleType || '').toUpperCase() === 'PCV';
      const policyIsTw  = String(params.vehicleType || '').toUpperCase() === 'TW' ||
                          String(params.vehicleType || '').toUpperCase() === '2W';
      const policyIsGcv = String(params.vehicleType || '').toUpperCase() === 'GCV';
      // Route/stage-carriage passenger buses → operator declines. Drop every
      // candidate segment so the policy resolves to no-rule (no captured rate).
      // EXCEPTION: IFFCO Tokio DOES pay route buses (the PCV grid rates them as
      // ordinary buses/PCV; operator paid the middle 3L-6L 0.175), so don't
      // decline them for IFFCO — let the normal bus/PCV segment matching apply.
      if (policyIsRouteBus && rule.insurer !== 'iffco_tokio') { matches = false; }
      if (matches && CAT_KEYWORDS.TAXI.test(seg) && !policyIsTaxi) {
        if (policyIsTw || policyIsGcv) matches = false;
        // PCV / CAR: keep, no score change — let other filters (seating /
        // CC / segment-make) decide.  Taxi rule for a Tavera-style PCV is
        // semantically valid.
      } else if (CAT_KEYWORDS.BUS.test(seg) && !policyIsBus) {
        if (policyIsTw || policyIsGcv) matches = false;
        // PCV: keep — bus rules apply to PCV bus-class policies.
      } else if (CAT_KEYWORDS.TRACTOR.test(seg) && !policyIsTractor) matches = false;
      else if (CAT_KEYWORDS.TRACTOR.test(seg) && policyIsTractor) {
        // Tractor policy + tractor segment → strong preference. Without
        // this score boost, a tractor policy with null tonnage was getting
        // beaten by GCV weight-band segments ("2_UPTO_3.5T", "10_ABOVE_47.5T-56T")
        // which trivially pass when tonnage is null.
        score += 12;
        // Honour [NEW] / [RENEWAL] bracket on Chola's "1_TRAC[...]" segments.
        const segIsNewVar = /\[NEW\]/i.test(seg);
        const segIsRenewVar = /\[RENEW(AL)?\]|\[ROLLOVER\]/i.test(seg);
        const bt = (params.businessType || '').toUpperCase();
        const policyIsNewBiz = bt === 'NEW' || bt === 'NEW BUSINESS';
        const policyIsRenewBiz = bt === 'RENEWAL' || bt === 'ROLLOVER';
        if (segIsNewVar && policyIsRenewBiz) matches = false;
        else if (segIsRenewVar && policyIsNewBiz) matches = false;
      }
      // Tractor policy: drop GCV weight-band / bus segments that would
      // otherwise win on tie when tonnage is null (Chola tractor rows have
      // no tonnage extracted, so weight bands skip their range check).
      if (matches && policyIsTractor && !CAT_KEYWORDS.TRACTOR.test(seg)) {
        const isWeightBandSeg = /\b\d+(?:\.\d+)?\s*T\b|\bUPTO\s*\d|\bABOVE\s*\d|\bGCCV\b|\b4W_LT_\d+CC\b|\bBUS\b|\bSCHOOL\b|\bSTAFF\b|\bTAXI\b|\bRICKSHAW\b|\b3W\b|\b\d+(?:\.\d+)?\s*(?:to|-)\s*\d+(?:\.\d+)?\b/i.test(seg);
        // A tractor is never a goods/passenger carrier — drop any GCV/PCV/CV
        // product segment (e.g. Royal's "Goods Carrying Garbage vehicle",
        // "UPTO_3500") so only a dedicated tractor / MISC segment can win.
        const isCvProductSeg = /^(GCV|PCV|CV|GCCV|GCCV3W?|TAXI|SCHOOL_STAFF_BUS)$/i
          .test(String(rule.product || ''));
        if (isWeightBandSeg || isCvProductSeg) matches = false;
      }

      // MISC (construction equipment, tippers, dumpers, cranes — "MISC-D")
      // must match a dedicated Misc / Miscellaneous segment, not a GCV
      // weight-band. For a MISC policy the tonnage filter is skipped (null
      // GVW), so GCV bands like "GCV > 45" trivially pass and shadow the
      // correct "Misc" rate. Prefer the Misc segment and drop GCV/PCV/Bus
      // weight-band segments for a MISC policy (unless it's a tractor, which
      // has its own handling above).
      if (matches && policyIsMiscType && !policyIsTractor) {
        const segIsMisc = /\bMISC\b|MISCELLANEOUS/i.test(seg);
        if (segIsMisc) {
          score += 12;                 // strong preference for the Misc segment
        } else {
          const segIsGcvBand = /\bGCV\b|\bGCCV\b|\b\d+(?:\.\d+)?\s*T\b|\bUPTO\s*\d|\bABOVE\s*\d|>\s*\d|<=?\s*\d|\bPCV\b|\bBUS\b|\bTAXI\b/i.test(seg);
          if (segIsGcvBand) matches = false;   // wrong family for MISC → drop
        }
      }
      if (matches && CAT_KEYWORDS.RICKSHAW.test(seg) && !policyIsRickshaw) {
        // 3W / Rickshaw rules — for non-3W policies (cars, trucks, etc.),
        // hard-drop. Only match when policy is rickshaw / GCV3.
        matches = false;
      }

      // (b) Required hint — only force when category in source is reliable.
      //     For PCV policies we accept Taxi / Bus / Rickshaw / TaxiSeg-style
      //     segments interchangeably (source vehicleCategory is often noisy
      //     for passenger commercial — Tavera as "Route Bus" etc.).
      if (matches) {
        const segHasVehicleHint = CAT_KEYWORDS.TAXI.test(seg) || CAT_KEYWORDS.BUS.test(seg) ||
                                  CAT_KEYWORDS.RICKSHAW.test(seg) || CAT_KEYWORDS.TRACTOR.test(seg);
        if (policyIsRickshaw) {
          // PCV 3-wheeler autos (Bajaj RE, Piaggio Ape passenger, Atul
          // Gemini, Mahindra Alfa, Champion E-Rickshaw) are often priced
          // under PCV-Taxi segments by insurers that don't ship a
          // dedicated 3W catalog (e.g. ICICI's "PCVTAXI<=1000CC"). Accept
          // TAXI segments alongside rickshaw-specific ones for PCV class.
          if (policyIsPcv) {
            if (!CAT_KEYWORDS.RICKSHAW.test(seg) && !CAT_KEYWORDS.TAXI.test(seg)) matches = false;
            // When a dedicated rickshaw / 3W segment exists in the candidate
            // set, a 3-wheeler policy must NOT borrow a generic Taxi rate —
            // drop Taxi-only segments so the rickshaw segment wins outright.
            else if (hasDedicatedRickshawSeg && CAT_KEYWORDS.TAXI.test(seg) && !CAT_KEYWORDS.RICKSHAW.test(seg)) matches = false;
          } else if (policyIsGcv) {
            // GCV 3W cargo (Atul Elite Cargo, Piaggio Ape Xtra, Mahindra
            // Treo Zor, etc.) is often priced under generic small-CV
            // segments when the insurer doesn't ship a dedicated 3W cargo
            // catalog. Accept SCV / LCV-style commercial segments. Refuse
            // only true non-commercial categories (TAXI/BUS/PCV-only).
            const segIsCommercial = /\bSCV\b|\bLCV\b|\bMCV\b|\bHCV\b|\bMHCV\b|\bGCV\b|\bGCCV\b|\bGOODS\b|\bCARGO\b|\bTRUCK\b|\bTIPPER\b|\bDUMPER\b|\bTANKER\b|\bTRAILER\b|GVW\b|\d+\s*T\b|UPTO\s*\d|ABOVE\s*\d/i.test(seg);
            if (!CAT_KEYWORDS.RICKSHAW.test(seg) && !segIsCommercial) matches = false;
          } else if (!CAT_KEYWORDS.RICKSHAW.test(seg)) matches = false;
        } else if (policyIsTaxi && !policyIsPcv) {
          // Pvt-Car-classified taxis (rare) — require Taxi segment.
          if (!CAT_KEYWORDS.TAXI.test(seg)) matches = false;
        } else if (policyIsBus && !policyIsPcv) {
          if (!CAT_KEYWORDS.BUS.test(seg) && segHasVehicleHint) matches = false;
        }
        // Strict PCV sub-type partition (per operator rule): when the source
        // vehicleCategory is a RELIABLE passenger sub-type, taxi / bus / 3W
        // segments are NOT interchangeable — seating capacity alone must not
        // let a Taxi rate match a Bus policy (or vice-versa). Only enforced
        // when a same-family alternative exists in the candidate set, so a
        // policy is never stranded at no-rule. Route buses are dropped
        // entirely upstream; 3W handled by the rickshaw branch above.
        if (policyIsPcv && !policyIsRickshaw && !policyIsRouteBus) {
          const segIsTaxi = CAT_KEYWORDS.TAXI.test(seg);
          const segIsBus  = CAT_KEYWORDS.BUS.test(seg);
          // Taxi policy (clean "…TAXI…" category) must not take a Bus row.
          if (policyIsTaxi && !policyIsBus && segIsBus && !segIsTaxi && hasTaxiSeg) {
            matches = false;
          }
          // Bus policy (clean "…BUS…" category, non-route) must not take a Taxi row.
          else if (policyIsBus && !policyIsTaxi && segIsTaxi && !segIsBus && hasBusSeg) {
            matches = false;
          }
        }
        // PCV catch-all: source category not reliable — let scoring pick
        // the best segment.  segHasVehicleHint adds a small bonus when
        // the segment is in the PCV product family (any Taxi/Bus/3W).
        if (policyIsPcv && segHasVehicleHint) score += 2;
        // Subtype-specific boost: when the policy and segment agree on
        // 3W / rickshaw, taxi, or bus, prefer that over a generic PCV
        // sibling. Without this, a 3W auto-rickshaw policy can tie
        // with a "PCV Taxi 6+1" rule and pick the wrong segment.
        if (policyIsRickshaw && CAT_KEYWORDS.RICKSHAW.test(seg)) score += 6;
        else if (policyIsTaxi && CAT_KEYWORDS.TAXI.test(seg)) score += 6;
        else if (policyIsBus && CAT_KEYWORDS.BUS.test(seg)) score += 6;
        // A rickshaw / E-Rickshaw policy should prefer a dedicated rickshaw
        // (3W) segment over a Taxi segment when BOTH exist — Digit ships a
        // CV-grid "E-Rickshaw" row AND a "Taxi … Electric" row for the same
        // region, and the taxi row's "upto 5 seater" seating bonus otherwise
        // ties/beats the rickshaw match. Penalise the taxi alternative so the
        // rickshaw segment wins. When NO rickshaw segment exists (insurers
        // without a 3W catalog), every taxi candidate shares this penalty, so
        // their relative order — and the chosen fallback — is unchanged.
        else if (policyIsRickshaw && CAT_KEYWORDS.TAXI.test(seg)) score -= 5;
        // Electric-3W specificity: an E-Rickshaw (electric 3W passenger) policy
        // must price off the dedicated "E-Rickshaw" segment, NOT a generic
        // "PCV3W non-diesel" 3W segment (which targets petrol/CNG autos and
        // also carries an unparsed "Age 6+" band that wrongly survives for a
        // young vehicle). When the policy is electric AND the segment is the
        // E-Rickshaw row, boost it decisively above the non-diesel sibling.
        const segIsERick    = /E[-\s]?RIKSHAW|E[-\s]?RICKSHAW/i.test(seg);
        const policyIsERick = /E[-\s]?RIKSHAW|E[-\s]?RICKSHAW|E[-\s]?RICK/i.test(`${vehicleCategory} ${model}`);
        const policyIsElectric = /ELECTRIC|BATTERY|\bEV\b/i.test(fuelType);
        if (segIsERick && (policyIsERick || policyIsElectric)) score += 10;
      }
    }

    // PCV wheel-class + School/Non-School + seating-band matching.
    // TATA's PCV grid splits passenger vehicles into "PCV 2W", "PCV 3W",
    // "PCV 4W School", "PCV 4W Non School", and seated bus bands like
    // "PCV Bus School 12 to 15". The generic CAT_KEYWORDS matcher above
    // can't tell these apart, so a 4-wheeler 5-seat school van (Maruti
    // Eeco) wrongly landed on the cheap "PCV 2W" rate. Here we:
    //   • match the wheel class (2W / 3W / 4W) against the policy,
    //   • prefer School vs Non-School per the policy's category,
    //   • honour a seating band ("12 to 15") encoded in the segment.
    const policyIsPcvLocal = String(params.vehicleType || '').toUpperCase() === 'PCV';
    const policyIsRickshawLocal = /RIKSHAW|RICKSHAW|E[-\s]?RICK|E[-\s]?RIK|\b3W\b|TREO|PCV3W?/i
      .test(`${vehicleCategory} ${model}`);
    if (matches && policyIsPcvLocal) {
      // (1) Wheel class. "PCV 2W"/"PCV 3W"/"PCV 4W".
      const segPcvWheel = seg.match(/\bPCV\s*([234])\s*W\b/);
      if (segPcvWheel) {
        const segW = segPcvWheel[1];
        // Rickshaw/auto = 3W; everything else passenger (car/van/bus) = 4W.
        const policyW = policyIsRickshawLocal ? '3' : '4';
        if (segW === policyW) score += 6;
        else matches = false;            // wrong wheel class → drop
      }
      // (2) School vs Non-School. Policy category carries "School Bus".
      if (matches) {
        const segNonSchool = /NON[\s_-]*SCHOOL/i.test(seg);
        const segSchool    = /\bSCHOOL\b/i.test(seg) && !segNonSchool;
        const policyIsSchool = /SCHOOL/i.test(vehicleCategory);
        if (segSchool || segNonSchool) {
          if (policyIsSchool && segSchool)        score += 8;
          else if (policyIsSchool && segNonSchool) matches = false;
          else if (!policyIsSchool && segNonSchool) score += 4;
          else if (!policyIsSchool && segSchool)   matches = false;
        }
      }
      // (2b) Bus-type exclusivity. A "School & Staff Bus" grid carries only
      // School Bus and Staff Bus segments. A Route Bus / Stage Carriage /
      // generic passenger bus is NEITHER and must not borrow a staff/school
      // rate — the operator declines these (no rate defined → no commission).
      // Prarambh categories: "PCV-School Bus", "PCV-Staff Bus", "Route Bus".
      if (matches) {
        const segStaffBus  = /STAFF\s*BUS/i.test(seg);
        const segSchoolBus = /SCHOOL\s*BUS/i.test(seg);
        if (segStaffBus || segSchoolBus) {
          const polStaffBus  = /STAFF\s*BUS/i.test(vehicleCategory);
          const polSchoolBus = /SCHOOL\s*BUS/i.test(vehicleCategory);
          if (segStaffBus && !polStaffBus)        matches = false;
          else if (segSchoolBus && !polSchoolBus) matches = false;
        }
      }
      // (3) Seating band encoded in segment ("12 to 15", "16 to 30",
      //     "31 to 50", "> 50"). Drop when the policy's seating falls
      //     outside the band — a 5-seat van must not match a 12-15 bus.
      //     Seating-capacity rules apply ONLY to passenger sub-types that are
      //     actually seating-banded (Taxi / School & Staff Bus). A 3-wheeler
      //     (auto / e-rickshaw) is NOT seating-banded — skip the band check so
      //     its seating doesn't accidentally qualify it for a taxi/bus row.
      if (matches && seating != null && !policyIsRickshawLocal) {
        // Strip the engine-capacity qualifier first. Digit taxi segments carry
        // "> 1000 cc" / "< 1000 cc" / "<= 1000 CC" which a naive ">\s*(\d+)"
        // misreads as a *seating* threshold (seating > 1000), wrongly dropping
        // every 5-/7-seater taxi. Remove any "<>= NNN cc" token before parsing.
        const segSeat = seg.replace(/[<>]=?\s*\d+\s*CC\b/gi, ' ');
        let segSeatMin = null, segSeatMax = null, m;
        // "upto N seater" / "up to N seat" → 0..N (Taxi grids: "upto 5 seater").
        if ((m = segSeat.match(/\bup\s*to\s*(\d+)\s*(?:seat|str|seater|pax|passenger)/i))) {
          segSeatMin = 0; segSeatMax = +m[1];
        }
        // Explicit band "12 to 15" (buses). Only when seat-context nearby OR a
        // small-vs-large bus range (both endpoints reasonable seat counts).
        else if ((m = segSeat.match(/(\d+)\s*to\s*(\d+)/i))) { segSeatMin = +m[1]; segSeatMax = +m[2]; }
        // "> N" / ">= N" with seat context only (e.g. "> 50 seater", "> 50 str").
        else if ((m = segSeat.match(/>\s*=?\s*(\d+)\s*(?:seat|str|seater|pax|passenger)?/i))
                 && /(?:seat|str|seater|pax|passenger|bus)/i.test(segSeat)) {
          segSeatMin = +m[1] + (segSeat.match(/>=/) ? 0 : 1); segSeatMax = 9999;
        }
        else if ((m = segSeat.match(/<\s*=?\s*(\d+)\s*(?:seat|str|seater|pax|passenger)/i))) {
          segSeatMin = 0; segSeatMax = +m[1];
        }
        if (segSeatMin != null) {
          if (seating >= segSeatMin && seating <= segSeatMax) score += 5;
          else matches = false;
        }
      }
    }

    // Make matching from rule.make field — "All" / "Any" / "*" / blank = wildcard,
    // "Others" = catch-all fallback (kept with low priority).
    //
    // MISC quirk (e.g. Chola): for Miscellaneous / Construction Equipment, insurers
    // store the **vehicle category** (Loader / Crane / Excavator / Bulldozer /
    // Road Roller / Fork Lift) in rule.make instead of the OEM. Policies have
    // that category in vehicleCategory (e.g. "MISC - D - Loader"). So for MISC
    // policies we match rule.make tokens against the category keyword, not the
    // manufacturer name.
    if (matches && rule.make) {
      const ruleMake = (rule.make || '').toUpperCase();
      const primaryMake = (make || '').split(/\s+/)[0];
      const isWildcard = ruleMake === 'ALL' || ruleMake === 'ANY' || ruleMake === '*' || ruleMake === '';
      const isOthersFallback = /\bOTHERS?\b/.test(ruleMake);

      // Build the set of MISC category keywords present in the policy's vehicleCategory.
      const MISC_CATEGORY_KEYWORDS = [
        { label: 'LOADER',       re: /\bLOADER\b|\bSKID\s*STEER\b/ },
        { label: 'EXCAVATOR',    re: /\bEXCAVATOR\b|\bEARTH\s*MOVER\b|\bEARTHMOVER\b|\bBACKHOE\b/ },
        { label: 'CRANE',        re: /\bCRANE\b|\bHYDRAULIC\s*CRANE\b/ },
        { label: 'BULLDOZER',    re: /\bBULLDOZER\b|\bBULLGRADER\b|\bBULL\s*GRADER\b|\bDOZER\b|\bGRADER\b/ },
        { label: 'ROAD_ROLLER',  re: /\bROAD\s*ROLLER\b|\bROLLER\b/ },
        { label: 'FORK_LIFT',    re: /\bFORK\s*LIFT\b|\bFORKLIFT\b/ },
        { label: 'HARVESTER',    re: /\bHARVESTER\b|\bHARVESTOR\b/ },
        { label: 'TRACTOR',      re: /\bTRACTOR\b/ },
      ];
      const policyCategoryProbe = (vehicleCategory + ' ' + model + ' ' + (params.vehicleSubModel || '')).toUpperCase();
      const policyMiscCategories = MISC_CATEGORY_KEYWORDS
        .filter(k => k.re.test(policyCategoryProbe))
        .map(k => k.label);

      // For each MISC category the policy has, build a matcher over rule.make.
      // rule.make may list several categories separated by "," or "/".
      const ruleCategoryHit = policyMiscCategories.some(cat => {
        const patterns = {
          LOADER:      /\bLOADER\b|SKID\s*STEER/,
          EXCAVATOR:   /\bEXCAVATOR\b|EARTH\s*MOVER|EARTHMOVER|BACKHOE/,
          CRANE:       /\bCRANE\b/,
          BULLDOZER:   /\bBULLDOZER\b|BULLGRADER|BULL\s*GRADER|\bDOZER\b|\bGRADER\b/,
          ROAD_ROLLER: /\bROAD\s*ROLLER\b|\bROLLER\b/,
          FORK_LIFT:   /\bFORK\s*LIFT\b|\bFORKLIFT\b/,
          HARVESTER:   /\bHARVESTER\b|\bHARVESTOR\b/,
          TRACTOR:     /\bTRACTOR\b/,
        };
        const pat = patterns[cat];
        return pat && pat.test(ruleMake);
      });

      // Commercial-vehicle make families. CV rate cards (notably Royal's GCV
      // grid) split each tonnage band by manufacturer — "Tata", "Ashok Leyland",
      // "Eicher" specific rows (rule.make = "Tata, Ashok Leyland" / "Eicher" /
      // "Only, Ashok Leyland") plus a blank-make ("") "Other than …" wildcard
      // fallback. Plain substring matching fails here: the policy make string is
      // glued and suffixed ("AshokLeylandLtd." / "TataMotorsLtd"), so it is not a
      // substring of the spelled-out "Ashok Leyland" / "Tata" in rule.make — so
      // every Tata/AL/Eicher truck fell through to the blank wildcard "Other
      // than" row (rate 0) instead of its real make-specific band. Match on
      // normalized family tokens so the make-specific row wins, and hard-drop a
      // make-specific row whose family the policy doesn't belong to (a Tata-only
      // row must not apply to an Ashok Leyland truck). 'cvFam' = 'match' / 'drop'
      // / null (rule.make doesn't name a CV make family → fall through to the
      // generic substring logic below, unchanged for non-CV cards).
      const CV_FAMILIES = [
        { fam: 'ASHOKLEYLAND', polRe: /ASHOKLEYLAND/,        ruleRe: /ASHOK\s*LEYLAND/ },
        { fam: 'TATA',         polRe: /^TATA|TATAMOTORS/,    ruleRe: /\bTATA\b/ },
        { fam: 'EICHER',       polRe: /EICHER/,              ruleRe: /\bEICHER\b/ },
      ];
      const makeNorm = (make || '').replace(/[^A-Z]/g, '');
      const polFam = CV_FAMILIES.find(f => f.polRe.test(makeNorm));
      const ruleFams = CV_FAMILIES.filter(f => f.ruleRe.test(ruleMake)).map(f => f.fam);
      let cvFam = null;
      if (ruleFams.length > 0) cvFam = (polFam && ruleFams.includes(polFam.fam)) ? 'match' : 'drop';

      if (isWildcard) {
        // applies to any make — no score bump, no rejection
      } else if (policyMiscCategories.length > 0 && ruleCategoryHit) {
        score += 10; // MISC category hit (Chola-style)
      } else if (policyMiscCategories.length > 0 && !ruleCategoryHit && !isOthersFallback) {
        // Policy has a MISC category, rule.make lists categories but none match
        // (e.g. policy=Loader, rule.make="Crane, Excavator") → drop.
        const looksLikeCategoryList = /(LOADER|EXCAVATOR|CRANE|BULLDOZER|ROLLER|FORKLIFT|GRADER|HARVEST|TRACTOR)/.test(ruleMake);
        if (looksLikeCategoryList) matches = false;
      } else if (cvFam === 'match') {
        score += 10; // CV make-family match (Tata / Ashok Leyland / Eicher)
      } else if (cvFam === 'drop') {
        matches = false; // make-specific CV row for a family the policy isn't
      } else if (ruleMake.includes(primaryMake) || (make && ruleMake.includes(make))) {
        score += 10;
      } else if (isOthersFallback) {
        score += 1; // generic fallback, low priority
      } else {
        matches = false;
      }
    }

    // Reliance School Bus ownership sub_type filter — School Bus policies
    // are by definition operated by schools / institutions, never by
    // individuals. The Reliance grid splits School Bus rates into 4
    // sub_types (>10/≤10 Year × Owned by Individual / Owned by School);
    // for a School Bus policy we must drop the "Owned by Individual"
    // variants and prefer "Owned by School".
    if (matches && rule.sub_type) {
      const st = String(rule.sub_type).toUpperCase();
      const policyIsSchoolBus = /SCHOOL\s*BUS/i.test(vehicleCategory) ||
                                /SCHOOL\s*BUS/i.test(params.segment || '');
      if (policyIsSchoolBus && /OWNED\s+BY\s+INDIVIDUAL/.test(st)) {
        matches = false;
      } else if (policyIsSchoolBus && /OWNED\s+BY\s+SCHOOL/.test(st)) {
        score += 6;
      }
    }

    // Owner-class sub_type triplet (Go Digit School & Staff Bus grid): the SAME
    // School Bus row is filed three times, differing only by sub_type —
    // "School" (institution-owned, higher rate) vs "Company" / "Individual"
    // (lower rate). Match the rule's owner class to the policy owner so a
    // society/company-owned bus doesn't borrow the "School"-owned rate.
    // Guarded to the plain owner-class tokens so it never collides with the
    // Reliance "Owned by ..." variants handled above.
    if (matches && rule.sub_type && params.ownerClass) {
      const stRaw = String(rule.sub_type).trim();
      const st = stRaw.toUpperCase();
      if (st === 'SCHOOL' || st === 'COMPANY' || st === 'INDIVIDUAL') {
        const oc = String(params.ownerClass).toUpperCase();
        // Treat Company & Individual as equivalent "non-institution" classes
        // (both priced identically in the grid); only the School class is
        // distinct. Match exactly where possible, else accept the sibling
        // non-institution row but drop the School row for non-institutions.
        if (oc === st) score += 8;
        else if (st === 'SCHOOL') matches = false;            // non-school owner can't use the School row
        else if (oc === 'SCHOOL') matches = false;            // school owner can't use Company/Individual row
        // else (Company vs Individual mismatch) → keep, same rate.
      }
    }

    if (_trace) {
      _trace.push({ rt: rule.rate_type, seg: rule.segment, region: rule.region,
                    score, matches });
    }
    return { rule, score, matches };
  });

  // Filter to only matching rules
  let filtered = scored.filter(s => s.matches);

  // If we have scored matches, group by rate_type and pick best score per type.
  // Tie-breaker: a non-declined rule with a positive rate_value beats a
  // declined / zero-rate rule with the same score. Magma's GJ3 SATP for
  // Pvt Car Diesel ships parallel rules per volume_tier (Upto 2L / 5L /
  // 20L+) — some bands are BLOCKED (is_declined=true, rate_value=0) and
  // others have real rates. When IDV is unknown the smart filter can't
  // narrow on volume_tier, so we must avoid picking the declined variant.
  // Bajaj Allianz residual catch-all suppression (pre-byType). Several Bajaj
  // SATP grids file a residual "Other districts @ IRDA" / "Other RTOs @ IRDA" /
  // "Remaining RTOs @ NO PAYOUT" row — carried as sub_type='Others' — alongside
  // the real district/RTO PO row for the SAME state region. Our rto_mappings
  // collapses every district to the state region (no per-district mapping), so
  // both rows reach the pool with the same score; byType's tie-break then keeps
  // whichever it iterates first, letting the low IRDA/NO-PAYOUT residual beat
  // the real PO rate (e.g. UP TW Bike: 0.025 "Other districts @ IRDA" out-ranks
  // the 0.445 PO row, so every UP bike scored 2.5 vs operator 44). The residual
  // is by definition the lowest-priority fallback — drop it whenever a
  // non-residual sibling of the SAME rate_type survives, so the PO rate wins.
  // (The existing segment-OTHERS filter below only fires at score>=10 and only
  // checks the SEGMENT text, missing these sub_type/remarks-encoded residuals.)
  if (filtered.length > 1 && filtered.some(s => s.rule.insurer === 'bajaj_allianz')) {
    // The residual row is uniquely flagged by sub_type='Others' (the real PO
    // row carries sub_type=NULL even though its remarks may mention "All other
    // districts at IRDA" — so a remarks regex would wrongly tag both).
    const isResidual = (r) =>
      r.insurer === 'bajaj_allianz' &&
      String(r.sub_type || '').trim().toUpperCase() === 'OTHERS';
    const nonResidualTypes = new Set(
      filtered.filter(s => !isResidual(s.rule)).map(s => s.rule.rate_type)
    );
    if (nonResidualTypes.size > 0) {
      filtered = filtered.filter(s => !(isResidual(s.rule) && nonResidualTypes.has(s.rule.rate_type)));
    }
  }

  if (filtered.length > 0) {
    const isLiveRate = (r) => r && r.rate_value != null && r.rate_value > 0 && !r.is_declined;
    const byType = {};
    for (const s of filtered) {
      const rt = s.rule.rate_type;
      const cur = byType[rt];
      if (!cur) { byType[rt] = s; continue; }
      // Prefer higher score; on tie, prefer live (non-declined, rate>0).
      if (s.score > cur.score) byType[rt] = s;
      else if (s.score === cur.score && isLiveRate(s.rule) && !isLiveRate(cur.rule)) {
        byType[rt] = s;
      }
    }
    let kept = Object.values(byType);
    if (_trace) _trace.push({ stage: 'after_byType', count: kept.length,
      list: kept.map(s => ({ rt: s.rule.rate_type, seg: s.rule.segment, score: s.score })) });

    // SBI PCV Taxi Nil-Dep resolution — same Depreciation-flag logic as the
    // Royal GCV block below. SBI's PCV Taxi grid files parallel COMP_NilDep /
    // COMP_NoNilDep rates; byType keeps both and pickPrimaryRateRule is
    // score-blind (defaults to the cheaper NilDep), so a no-zero-dep taxi wrongly
    // got the with-Nil-Dep rate. The cover flag is Prarambh_Live
    // TRN_PrarambhMotorDetails.Depreciation (1=Nil-Dep / 2=No → params._depreciation).
    // When both variants survive, keep the one matching the policy.
    if (kept.length > 1 &&
        kept.some(s => /sbi/i.test(String(s.rule.insurer || ''))) &&
        String(params.vehicleType || '').toUpperCase() === 'PCV') {
      const rtOf = (s) => String(s.rule.rate_type || '').toUpperCase();
      const hasNil   = kept.some(s => rtOf(s) === 'COMP_NILDEP');
      const hasNoNil = kept.some(s => rtOf(s) === 'COMP_NONILDEP');
      if (hasNil && hasNoNil) {
        const polHasNilDep = Number(params._depreciation) === 1;
        const dropRt = polHasNilDep ? 'COMP_NONILDEP' : 'COMP_NILDEP';
        kept = kept.filter(s => rtOf(s) !== dropRt);
      }
    }

    // Royal GCV Nil-Dep resolution. The grid files parallel "with Nil Dep"
    // (rate_type Comp_NilDep) and "without Nil Dep" (Comp_NoNilDep) variants of
    // each tonnage/disc/make band. byType keeps the best-scored rule of EACH
    // type, and pickPrimaryRateRule then takes whichever came first in SQL order
    // (score-blind) — usually the cheaper Comp_NilDep, so a non-nil-dep truck
    // wrongly got the with-Nil-Dep rate. The authoritative cover flag is
    // Prarambh_Live TRN_PrarambhMotorDetails.Depreciation (1=Nil-Dep / 2=No),
    // fed in as params._depreciation. When both variants survive, keep only the
    // one matching the policy: _depreciation===1 → Comp_NilDep, else (2/missing)
    // → Comp_NoNilDep (these trucks carry no zero-dep add-on). Only acts when an
    // alternative exists, so plain-"Comp" bands and other insurers are untouched.
    if (kept.length > 1 &&
        kept.some(s => s.rule.insurer === 'royal_sundaram') &&
        String(params.vehicleType || '').toUpperCase() === 'GCV') {
      const rtOf = (s) => String(s.rule.rate_type || '').toUpperCase();
      const hasNil   = kept.some(s => rtOf(s) === 'COMP_NILDEP');
      const hasNoNil = kept.some(s => rtOf(s) === 'COMP_NONILDEP');
      if (hasNil && hasNoNil) {
        const polHasNilDep = Number(params._depreciation) === 1;
        const dropRt = polHasNilDep ? 'COMP_NONILDEP' : 'COMP_NILDEP';
        kept = kept.filter(s => rtOf(s) !== dropRt);
      }

      // Royal GCV "(TATA & AL)" make-specific vs "Other than TATA & AL"
      // catch-all. Each tonnage/disc band is filed as a make-specific row
      // (rule.make = "Tata, Ashok Leyland[, Only]") AND a make-BLANK catch-all
      // whose split is encoded only in the SEGMENT text ("Other than TATA, Ashok
      // Leyland"). The blank catch-all passes the rule.make gate as a wildcard,
      // and (often a plain `Comp` rate_type) competes with the make-specific
      // Comp_NoNilDep — winning by score-blind SQL order. Drop the wrong side by
      // the policy's CV make-family, but ONLY when a same-side row survives, so
      // no policy is left ruleless. (Complements the rule.make CV-family gate:
      // there the named rows are scored; here the make-blank segment variants.)
      const segOther  = (s) => /OTHER\s*THAN\s*TATA/i.test(String(s.rule.segment || ''));
      const segTataAl = (s) => !segOther(s) &&
        /TATA\s*&\s*AL|TATA&AL|TATA,\s*ASHOK\s*LEYLAND/i.test(String(s.rule.segment || ''));
      const polIsTataAlFam = /ASHOKLEYLAND|^TATA|TATAMOTORS|EICHER/.test(make.replace(/[^A-Z]/g, ''));
      if (polIsTataAlFam) {
        if (kept.some(segTataAl)) kept = kept.filter(s => !segOther(s));   // T/AL truck → drop "Other than" rows
      } else {
        if (kept.some(s => !segTataAl(s))) kept = kept.filter(s => !segTataAl(s)); // non-T/AL → drop "(TATA&AL)" rows
      }
    }

    // If any kept rule uses a specific make bucket (anything that isn't _Others),
    // drop the generic _Others fallback — it exists only as the catch-all when
    // no more specific rule is available.
    const hasSpecificBucket = kept.some(s => {
      const b = extractRateMakeBucket(s.rule.rate_type);
      return b && b !== 'Others';
    });
    if (hasSpecificBucket) {
      kept = kept.filter(s => extractRateMakeBucket(s.rule.rate_type) !== 'Others');
    }
    if (_trace) _trace.push({ stage: 'after_bucket_filter', count: kept.length,
      hasSpecificBucket });

    // Per-rate-type OTHERS preference: for each rate_type, if a non-OTHERS
    // variant of THAT SAME rate_type exists with score >= 10, drop the
    // OTHERS variant for that rate_type only.  Was previously a global
    // check that incorrectly suppressed OTHERS-segment rules when a
    // higher-scoring different-rate_type rule existed.
    const nonOthersByType = new Set();
    for (const s of kept) {
      const sg = (s.rule.segment || '').toUpperCase();
      if (!/\bOTHERS?\b/.test(sg) && s.score >= 10) nonOthersByType.add(s.rule.rate_type);
    }
    if (nonOthersByType.size > 0) {
      kept = kept.filter(s => {
        const sg = (s.rule.segment || '').toUpperCase();
        if (!/\bOTHERS?\b/.test(sg)) return true;          // not OTHERS — keep
        return !nonOthersByType.has(s.rule.rate_type);     // drop OTHERS only when same rate_type has non-OTHERS winner
      });
    }
    if (_trace) _trace.push({ stage: 'after_others_filter', count: kept.length,
      nonOthersByType: [...nonOthersByType] });

    // Prefer product-prefixed rate_types over plain ones when both exist.
    // e.g. drop plain "MAX_CD2" when "COMP_MAX_CD2" is already kept (the COMP_
    // variant is more specific to the policy product).
    const prefixedRt = new Set(
      kept.map(s => s.rule.rate_type).filter(rt => /^(COMP|SATP|SAOD|TP)[_\s]/.test(rt))
    );
    if (prefixedRt.size > 0) {
      kept = kept.filter(s => {
        const rt = s.rule.rate_type || '';
        if (/^(COMP|SATP|SAOD|TP)[_\s]/.test(rt)) return true; // already prefixed — keep
        // drop this plain rate_type if any prefixed variant (PREFIX_ + rt) is kept
        for (const pref of ['COMP', 'SATP', 'SAOD', 'TP']) {
          if (prefixedRt.has(pref + '_' + rt)) return false;
        }
        return true;
      });
    }
    if (_trace) _trace.push({ stage: 'final', count: kept.length,
      list: kept.map(s => ({ rt: s.rule.rate_type, seg: s.rule.segment, score: s.score })) });

    return kept.map(s => s.rule);
  }

  // No rules passed the filter. Return an empty list — the diagnostics panel
  // on the frontend will show which filter eliminated them. (Earlier the code
  // fell back to returning the full unfiltered list here, but that surfaced
  // wrong rules — e.g. MC bike rates for a scooter policy.)
  return [];
}

/**
 * Probe each filter to identify which one eliminated the matches.
 * Runs a cascade of lookups, each relaxing one filter, so the user can
 * see exactly where rules were dropped.
 *
 * Returns { steps: [...], smart_filter_drop: n|null } where each step has
 * { label, count, dropped_by }.
 */
async function buildDropDiagnostics(pool, { lookupParams, fallbackRegions, rulesBeforeSmartFilter, policyParams }) {
  // Region set to probe against — prefer the fallback list if used, else [region].
  const regions = (fallbackRegions && fallbackRegions.length > 0)
    ? fallbackRegions
    : (lookupParams.region ? [lookupParams.region] : []);
  const regionLabel = regions.length > 0 ? regions.join(' | ') : '(any region)';

  const probes = [
    {
      label: `Insurer only (${lookupParams.insurer})`,
      filter: { insurer: lookupParams.insurer },
    },
    {
      label: `+ Product=${lookupParams.product}`,
      filter: { insurer: lookupParams.insurer, product: lookupParams.product },
    },
    {
      label: `+ Region in [${regionLabel}]`,
      filter: {
        insurer: lookupParams.insurer,
        product: lookupParams.product,
        ...(regions.length > 1 ? { region_list: regions } : { region: regions[0] || '' }),
      },
    },
    {
      label: `+ Vehicle age = ${policyParams.vehicleAge ?? 'null'}`,
      filter: {
        insurer: lookupParams.insurer,
        product: lookupParams.product,
        ...(regions.length > 1 ? { region_list: regions } : { region: regions[0] || '' }),
        vehicle_age: lookupParams.vehicle_age,
      },
    },
    {
      label: `+ Fuel type = ${lookupParams.fuel_type || '(none)'}`,
      filter: {
        insurer: lookupParams.insurer,
        product: lookupParams.product,
        ...(regions.length > 1 ? { region_list: regions } : { region: regions[0] || '' }),
        vehicle_age: lookupParams.vehicle_age,
        fuel_type: lookupParams.fuel_type,
      },
    },
    {
      label: `+ Ins product = ${lookupParams.ins_product || '(none)'} (full lookup)`,
      filter: {
        insurer: lookupParams.insurer,
        product: lookupParams.product,
        ...(regions.length > 1 ? { region_list: regions } : { region: regions[0] || '' }),
        vehicle_age: lookupParams.vehicle_age,
        fuel_type: lookupParams.fuel_type,
        ins_product: lookupParams.ins_product,
      },
    },
  ];

  const steps = [];
  let prev = null;
  for (const p of probes) {
    try {
      const r = await lookupRates(pool, p.filter);
      const dropped = prev != null ? prev - r.length : null;
      steps.push({
        label: p.label,
        count: r.length,
        dropped_since_previous: dropped,
      });
      prev = r.length;
    } catch (err) {
      steps.push({ label: p.label, count: null, error: err.message });
    }
  }

  // Smart-filter drop at the end
  const smartDrop = rulesBeforeSmartFilter > 0 ? rulesBeforeSmartFilter : null;
  return {
    steps,
    smart_filter_drop: smartDrop, // how many we had before CC/make post-filter
  };
}

module.exports = router;
// Export helpers so the bulk-calculation route can reuse the exact same
// extract + resolve + filter pipeline as the single-policy lookup.
module.exports.extractPolicyParams  = extractPolicyParams;
module.exports.resolveInsurerSlug   = resolveInsurerSlug;
module.exports.filterRulesByPolicy  = filterRulesByPolicy;
module.exports.CLUSTER_STATE_MAP    = CLUSTER_STATE_MAP;
module.exports.STATE_REGION_MAP     = STATE_REGION_MAP;
module.exports.rtoStatePrefix       = rtoStatePrefix;
module.exports.inferLocationTiers   = inferLocationTiers;
module.exports.STATE_PREFIX_FULL    = STATE_PREFIX_FULL;
module.exports.US_STATE_REGION      = US_STATE_REGION;
module.exports.aliasIciciRegion     = aliasIciciRegion;
module.exports.ICICI_REGION_ALIASES = ICICI_REGION_ALIASES;
module.exports.aliasHdfcRegion      = aliasHdfcRegion;
module.exports.HDFC_REGION_ALIASES  = HDFC_REGION_ALIASES;
module.exports.aliasShriramRegion   = aliasShriramRegion;
module.exports.shriramRtoDeclined   = shriramRtoDeclined;
module.exports.getHdfcStateFallbacks = getHdfcStateFallbacks;
module.exports.HDFC_STATE_FALLBACKS  = HDFC_STATE_FALLBACKS;
module.exports.getIciciStateFallbacks = getIciciStateFallbacks;
module.exports.ICICI_STATE_FALLBACKS  = ICICI_STATE_FALLBACKS;
