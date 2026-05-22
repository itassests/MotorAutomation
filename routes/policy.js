const express = require('express');
const sql = require('mssql');
const { getPool } = require('../db/connection');
const { getPrarambhPool } = require('../db/prarambh-connection');
const { lookupRates, resolveRTO } = require('../services/rate-lookup');
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
      rtoInfo = await resolveRTO(pool, insurerSlug, params.vehicleType, params.rtoCode);
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
      const tierCandidates = inferLocationTiers(resolvedCluster || resolvedRegion, params._stateName);
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
      // Merge: cluster candidates first (RTO mapping authoritative), then
      // state-prefix candidates, then carrier-specific umbrella, then tier candidates.
      const seen = new Set();
      const candidates = [
        ...clusterCandidates, ...stateCandidates,
        ...hdfcCandidates, ...iciciCandidates,
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
  const segment = get('SEGMENT') || get('Segment') || '';
  const cc = get('CC') || '';
  const registrationDate = get('DATE OF REGISTRATION') || get('REGISTRATION DATE') || '';
  const vehicleSubModel = get('VEHICAL SUBMODAL') || '';
  const vehicleRegNo = (get('VEHICLE REGISTRATION NO') || get('VEHICLE REG NO') || get('VEHICLE NO') || get('REGISTRATION NO') || get('REG NO') || get('REGN NO') || get('VEHICLE REGISTRATION NUMBER') || '').toString().trim();

  // Seating capacity
  const seatingRaw = get('SEATING CAPACITY') || get('SEATING') || get('NO OF SEATS') || get('SEATS');
  const seatingCapacity = seatingRaw != null && seatingRaw !== '' && !isNaN(parseInt(seatingRaw))
    ? parseInt(seatingRaw, 10) : null;

  // Gross weight / tonnage (in KG typically; convert to tonnes if it looks like KG)
  const weightRaw = get('GROSS VEHICLE WEIGHT') || get('GVW') || get('TONNAGE') || get('UNLADEN WEIGHT') || get('GROSS WEIGHT');
  let tonnage = null;
  let tonnageMin = null;
  let tonnageMax = null;
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
      tonnage = (tonnageMin + tonnageMax) / 2;
    } else if ((m = cat.match(/upto\s*(\d+(?:\.\d+)?)\s*Tn?\b/i))) {
      tonnageMax = parseFloat(m[1]);
      tonnage = tonnageMax;
    } else if ((m = cat.match(/(\d+(?:\.\d+)?)\s*Tn?\s*\+/i))) {
      tonnageMin = parseFloat(m[1]);
      tonnage = tonnageMin;
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

  // If TP premium is 0 but we have net premium, derive TP = Net - OD - Addon
  if (tpPremium === 0 && netPremium > 0) {
    tpPremium = Math.max(0, netPremium - odPremium - addonPremium);
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

  // Clean RTO code — extract just the alpha-numeric RTO prefix (e.g., "MH01" from "MH-01-AB-1234")
  const cleanRTO = cleanRtoCode(rtoCode);

  return {
    insurerName: (insurerName || '').toString().trim(),
    policyType: (policyType || '').toString().trim(),
    vehicleClass: (vehicleClass || '').toString().trim(),
    vehicleType: mappedVehicleType,
    // Vehicle category uses the more-specific `VehicalCategory` when present
    // (e.g. "TW - Scooty" / "TW - Motorcycle" / "Car"); falls back to vehicleClass.
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
    carrierType,
    businessType,
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
function inferLocationTiers(cluster, stateName) {
  const c = String(cluster || '').toUpperCase().trim();
  const s = String(stateName || '').toUpperCase().trim();
  const tiers = [];
  if (KEY_CITIES.has(c)) tiers.push('Key Cities');
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
    { patterns: ['UNITED INDIA'], slug: 'united_india' },
    { patterns: ['ICICI LOMBARD'], slug: 'icici_lombard' },
    { patterns: ['HDFC ERGO'], slug: 'hdfc_ergo' },
    { patterns: ['TATA AIG'], slug: 'tata_aig' },
    { patterns: ['NATIONAL'], slug: 'national' },
    { patterns: ['NEW INDIA'], slug: 'new_india' },
    { patterns: ['ORIENTAL'], slug: 'oriental' },
    { patterns: ['SBI GENERAL'], slug: 'sbi_general' },
    { patterns: ['RELIANCE'], slug: 'reliance' },
    { patterns: ['IFFCO TOKIO', 'IFFCO'], slug: 'iffco_tokio' },
    { patterns: ['KOTAK'], slug: 'kotak' },
    { patterns: ['LIBERTY'], slug: 'liberty' },
    { patterns: ['MAGMA'], slug: 'magma' },
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
  // Extract first 4-6 chars that form a valid RTO prefix (2 alpha + 2 numeric)
  const match = cleaned.match(/^([A-Z]{2}\d{1,2})/);
  return match ? match[1] : cleaned;
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
  const m = rateType.match(/^(1\+1|1\+3|3\+3|1\+5|5\+5)_/i);
  return m ? m[1] : null;
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
  const policyTenure = null; // plain Comp/SAOD/TP = no tenure prefix; 1+1/1+3 policies would set this
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

  // Score each rule by how well its segment matches the policy
  const scored = rules.map(rule => {
    const seg = (rule.segment || '').toUpperCase();
    const rt = (rule.rate_type || '').toUpperCase();
    let score = 0;
    let matches = true;

    // --- Rate-type encoded filters (tenure + NCB flag + make bucket suffix) ---
    const rtTenure = extractRateTenure(rule.rate_type);
    const rtBucket = extractRateMakeBucket(rule.rate_type);

    // Drop tenure-prefixed rules unless the policy is that tenure product.
    // When the policy's tenure is unknown (policyTenure === null), let the
    // rule pass — the rate card's tenure is informational and shouldn't
    // veto a rule that's otherwise correct.  ICICI rate cards encode
    // tenure (1+1/1+5/2+2/3+3) on every rate_type; treating null as
    // "doesn't match" was eliminating all of them.
    if (matches && rtTenure && policyTenure != null && rtTenure !== policyTenure) {
      matches = false;
    }

    // NCB / NON_NCB encoded in rate_type (e.g. COMP_NCB vs COMP_NON_NCB).
    // Match the policy's NCB status. Rules with no NCB keyword apply to both.
    if (matches) {
      const rtIsNonNcb = /NON[_\s-]?NCB/.test(rt);
      const rtIsNcb = !rtIsNonNcb && /\bNCB\b|_NCB(_|$)/.test(rt);
      if (rtIsNonNcb && policyHasNCB) matches = false;
      else if (rtIsNcb && !policyHasNCB) matches = false;
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
        if (/^SATP([_\s]|$)/.test(rt)) matches = false;
        else if (/^ACT([_\s]|$)/.test(rt)) matches = false;
        else if (tataIsTp || tataIsSaod) matches = false;
      } else if (ip === 'TP') {
        if (/^COMP([_\s]|$)/.test(rt)) matches = false;
        else if (/^PACK([_\s]|$)/.test(rt)) matches = false;
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
    const skipRemarksState =
      (rule.insurer === 'hdfc_ergo' || rule.insurer === 'icici_lombard')
      && !isHdfcGenericRegion(rule.region);
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
      if (matches) score += 3;
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

    // Addon flag — prefer rules whose addon matches
    if (matches && rule.addon) {
      const ruleAddon = String(rule.addon).toLowerCase();
      const hasAddonFlag = ruleAddon === 'y' || ruleAddon === 'yes' || ruleAddon === 'true' || ruleAddon === '1';
      if (hasAddonFlag === policyHasAddon) score += 1;
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
    const BIKE_MODELS = /PULSAR|SPLENDOR|PASSION|DISCOVER|APACHE|UNICORN|SHINE|HORNET|AVENGER|DUKE|NINJA|THUNDER|BULLET|CLASSIC|MAVRICK|GIXXER|FZ\b|R15|YZF|MT\d|CB\s|CBR|CBZ|XPULSE|HIMALAYAN|METEOR|INTERCEPTOR|CONTINENTAL|SCRAM/i;

    const policyIsScooter = /SCOOTY|SCOOTER|TW\s*-\s*SCOO/i.test(vehicleCategory) ||
                            (SCOOTER_MODELS.test(model) && !BIKE_MODELS.test(model));
    const policyIsBike = /MOTORCYCLE|MOTOR[\s_]*CYCLE|\bMC\b|\bBIKE\b/i.test(vehicleCategory) ||
                         (BIKE_MODELS.test(model) && !SCOOTER_MODELS.test(model));

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
      const segHasOurMake = seg.includes(primaryMake) || seg.includes(make);
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
        RICKSHAW: /E[-\s]?RIKSHAW|E[-\s]?RICKSHAW|\bRICKSHAW\b|\bAUTO\s*RICKSHAW\b|\bPCV3W?\b|\b3W\b|\b3\s*WHEELER\b|\bTHREE\s*WHEELER\b|\bGCV3\b|\bGCV\s*3W?\b|GCCV[\s_-]*3W?|GCCV3|\bPCV\s*AUTO\b|\bPCV\s*[\dN].*SEATER\b/i,
      };

      const policyIsPvtCar = vehicleCategory.includes('PVT') || vehicleCategory.includes('PRIVATE') ||
                             vehicleCategory === 'CAR' || /PVT\.?\s*CAR/i.test(vehicleCategory);
      const policyIsTaxi = /\bTAXI\b/i.test(vehicleCategory);
      const policyIsBus = /\bBUS\b/i.test(vehicleCategory);
      const policyIsTractor = /\bTRACTOR\b/i.test(vehicleCategory);
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
      if (CAT_KEYWORDS.TAXI.test(seg) && !policyIsTaxi) {
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
        const isWeightBandSeg = /\b\d+(?:\.\d+)?\s*T\b|\bUPTO\s*\d|\bABOVE\s*\d|\bGCCV\b|\b4W_LT_\d+CC\b|\bBUS\b|\bSCHOOL\b|\bSTAFF\b|\bTAXI\b|\bRICKSHAW\b|\b3W\b/i.test(seg);
        if (isWeightBandSeg) matches = false;
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
          } else if (policyIsGcv) {
            // GCV 3W cargo (Atul Elite Cargo, Piaggio Ape Xtra, Mahindra
            // Treo Zor, etc.) is often priced under generic small-CV
            // segments when the insurer doesn't ship a dedicated 3W cargo
            // catalog. Accept SCV / LCV-style commercial segments. Refuse
            // only true non-commercial categories (TAXI/BUS/PCV-only).
            const segIsCommercial = /\bSCV\b|\bLCV\b|\bMCV\b|\bHCV\b|\bMHCV\b|\bGCV\b|\bGOODS\b|\bCARGO\b|\bTRUCK\b|\bTIPPER\b|\bDUMPER\b|\bTANKER\b|\bTRAILER\b|GVW\b|\d+\s*T\b|UPTO\s*\d|ABOVE\s*\d/i.test(seg);
            if (!CAT_KEYWORDS.RICKSHAW.test(seg) && !segIsCommercial) matches = false;
          } else if (!CAT_KEYWORDS.RICKSHAW.test(seg)) matches = false;
        } else if (policyIsTaxi && !policyIsPcv) {
          // Pvt-Car-classified taxis (rare) — require Taxi segment.
          if (!CAT_KEYWORDS.TAXI.test(seg)) matches = false;
        } else if (policyIsBus && !policyIsPcv) {
          if (!CAT_KEYWORDS.BUS.test(seg) && segHasVehicleHint) matches = false;
        }
        // PCV catch-all: source category not reliable — let scoring pick
        // the best segment.  segHasVehicleHint adds a small bonus when
        // the segment is in the PCV product family (any Taxi/Bus/3W).
        if (policyIsPcv && segHasVehicleHint) score += 2;
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

      if (isWildcard) {
        // applies to any make — no score bump, no rejection
      } else if (policyMiscCategories.length > 0 && ruleCategoryHit) {
        score += 10; // MISC category hit (Chola-style)
      } else if (policyMiscCategories.length > 0 && !ruleCategoryHit && !isOthersFallback) {
        // Policy has a MISC category, rule.make lists categories but none match
        // (e.g. policy=Loader, rule.make="Crane, Excavator") → drop.
        const looksLikeCategoryList = /(LOADER|EXCAVATOR|CRANE|BULLDOZER|ROLLER|FORKLIFT|GRADER|HARVEST|TRACTOR)/.test(ruleMake);
        if (looksLikeCategoryList) matches = false;
      } else if (ruleMake.includes(primaryMake) || (make && ruleMake.includes(make))) {
        score += 10;
      } else if (isOthersFallback) {
        score += 1; // generic fallback, low priority
      } else {
        matches = false;
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

  // If we have scored matches, group by rate_type and pick best score per type
  if (filtered.length > 0) {
    const byType = {};
    for (const s of filtered) {
      const rt = s.rule.rate_type;
      if (!byType[rt] || s.score > byType[rt].score) {
        byType[rt] = s;
      }
    }
    let kept = Object.values(byType);
    if (_trace) _trace.push({ stage: 'after_byType', count: kept.length,
      list: kept.map(s => ({ rt: s.rule.rate_type, seg: s.rule.segment, score: s.score })) });

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
module.exports.aliasIciciRegion     = aliasIciciRegion;
module.exports.ICICI_REGION_ALIASES = ICICI_REGION_ALIASES;
module.exports.aliasHdfcRegion      = aliasHdfcRegion;
module.exports.HDFC_REGION_ALIASES  = HDFC_REGION_ALIASES;
module.exports.getHdfcStateFallbacks = getHdfcStateFallbacks;
module.exports.HDFC_STATE_FALLBACKS  = HDFC_STATE_FALLBACKS;
module.exports.getIciciStateFallbacks = getIciciStateFallbacks;
module.exports.ICICI_STATE_FALLBACKS  = ICICI_STATE_FALLBACKS;
