/**
 * Margin rules — user defines a margin (%) for a descriptive filter
 * predicate (e.g. "chola gcv 2.5-5T chennai → 4%"). Each margin is stored
 * keyed by a canonical signature so duplicate definitions are detected and
 * the user is prompted to overwrite.
 *
 * Endpoints:
 *   POST   /api/margins/check    { filters }                       → { exists, existing? }
 *   POST   /api/margins          { description, filters, margin_pct, force? }
 *                                                                   → { id, action: 'created'|'updated' }
 *   GET    /api/margins                                             → { margins: [...] }
 *   DELETE /api/margins/:id                                         → { success }
 *
 * Rate preview is handled client-side from the existing Search Rates call
 * (outgoing = rate − margin), so no preview endpoint here — the rate lookup
 * is reused verbatim.
 */

const express = require('express');
const sql = require('mssql');
const path = require('path');
const XLSX = require('xlsx');
const multer = require('multer');
const { getPool } = require('../db/connection');

const router = express.Router();

// Multer setup for the bulk margin upload — store in same uploads dir as
// the rate-card/PR uploads so the file is on disk after processing for
// audit / re-parse.
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
const marginUploadStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `margins_${Date.now()}_${safe}`);
  },
});
const marginUpload = multer({
  storage: marginUploadStorage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB cap
});

/**
 * Build a deterministic signature from the filters object so two descriptions
 * that parse to the same condition collide. Keys are sorted alphabetically so
 * order doesn't matter, and falsy values are dropped.
 */
function signatureOf(filters) {
  if (!filters || typeof filters !== 'object') return '';
  const clean = {};
  for (const k of Object.keys(filters).sort()) {
    const v = filters[k];
    if (v === null || v === undefined || v === '') continue;
    clean[k] = typeof v === 'string' ? v.toLowerCase().trim() : v;
  }
  return JSON.stringify(clean);
}

/** POST /check — does a margin already exist for this filter signature? */
router.post('/check', async (req, res, next) => {
  try {
    const { filters } = req.body || {};
    const sig = signatureOf(filters);
    if (!sig) return res.status(400).json({ success: false, error: 'filters required' });

    const pool = await getPool();
    const r = await pool.request()
      .input('sig', sql.NVarChar(500), sig)
      .query(`SELECT TOP 1 id, description, margin_pct, filters_json, created_at, updated_at
              FROM margin_rules WHERE filter_signature = @sig AND active = 1`);

    if (r.recordset.length > 0) {
      return res.json({ success: true, exists: true, existing: r.recordset[0] });
    }
    res.json({ success: true, exists: false });
  } catch (err) { next(err); }
});

/** POST / — create or update (when force=true) a margin rule. */
router.post('/', async (req, res, next) => {
  try {
    const { description, filters, margin_pct, force } = req.body || {};
    if (!description || typeof description !== 'string') {
      return res.status(400).json({ success: false, error: 'description required' });
    }
    if (margin_pct == null || isNaN(Number(margin_pct))) {
      return res.status(400).json({ success: false, error: 'margin_pct required (number)' });
    }
    const sig = signatureOf(filters);
    if (!sig) return res.status(400).json({ success: false, error: 'filters must be a non-empty object' });

    const pool = await getPool();
    const existing = await pool.request()
      .input('sig', sql.NVarChar(500), sig)
      .query(`SELECT TOP 1 id FROM margin_rules WHERE filter_signature = @sig AND active = 1`);

    if (existing.recordset.length > 0 && !force) {
      return res.status(409).json({
        success: false,
        exists: true,
        existing_id: existing.recordset[0].id,
        error: 'A margin for this condition already exists. Send {force:true} to overwrite.',
      });
    }

    if (existing.recordset.length > 0 && force) {
      const id = existing.recordset[0].id;
      await pool.request()
        .input('id', sql.Int, id)
        .input('desc', sql.NVarChar(500), description)
        .input('filters', sql.NVarChar(sql.MAX), JSON.stringify(filters))
        .input('pct', sql.Decimal(6, 3), Number(margin_pct))
        .query(`UPDATE margin_rules
                SET description = @desc, filters_json = @filters, margin_pct = @pct, updated_at = GETDATE()
                WHERE id = @id`);
      return res.json({ success: true, id, action: 'updated' });
    }

    const ins = await pool.request()
      .input('desc', sql.NVarChar(500), description)
      .input('filters', sql.NVarChar(sql.MAX), JSON.stringify(filters))
      .input('sig', sql.NVarChar(500), sig)
      .input('pct', sql.Decimal(6, 3), Number(margin_pct))
      .query(`INSERT INTO margin_rules (description, filters_json, filter_signature, margin_pct)
              OUTPUT INSERTED.id
              VALUES (@desc, @filters, @sig, @pct)`);
    res.json({ success: true, id: ins.recordset[0].id, action: 'created' });
  } catch (err) { next(err); }
});

/** GET / — list active margins. */
router.get('/', async (req, res, next) => {
  try {
    const pool = await getPool();
    const r = await pool.request().query(
      `SELECT id, description, filters_json, margin_pct, created_at, updated_at, created_by
       FROM margin_rules WHERE active = 1 ORDER BY updated_at DESC`
    );
    // Parse filters_json so the UI doesn't have to.
    const margins = r.recordset.map(row => ({
      ...row,
      filters: (() => { try { return JSON.parse(row.filters_json); } catch { return null; } })(),
    }));
    res.json({ success: true, margins });
  } catch (err) { next(err); }
});

/** Canonical insurer slug — collapses common synonyms so "digit" and
 *  "go_digit" don't read as separate insurers. Mirror of the helper in
 *  routes/bulk.js. */
function canonInsurer(slug) {
  const s = String(slug || '').toLowerCase().trim();
  const aliases = {
    digit: 'go_digit', go_digit: 'go_digit',
    chola: 'chola_ms', chola_ms: 'chola_ms',
    bajaj: 'bajaj_allianz', bajaj_allianz: 'bajaj_allianz',
  };
  return aliases[s] || s;
}

/** Vehicle-type normaliser — same map used in policyMatchesMargin so the
 *  coverage check uses identical product semantics. */
const VTYPE_MAP = {
  'PVT CAR': 'CAR', 'PVT.CAR': 'CAR', '4W': 'CAR', 'CAR': 'CAR', 'PC': 'CAR',
  'TW': 'TW', '2W': 'TW', 'TW_EV': 'TW',
  'GCV': 'GCV', 'CV': 'GCV',
  'PCV': 'PCV',
  'MIS': 'MISC', 'MISC': 'MISC',
};
function normVtype(s) {
  const u = String(s || '').toUpperCase().replace(/\s+/g, ' ').trim();
  return VTYPE_MAP[u] || u;
}

/** State name / abbreviation forms — both directions. Used by the state /
 *  cluster substring check so a margin saved with state="Tamil Nadu" matches
 *  rate_rules whose region is "TN" (or vice versa). Also covers compressed
 *  forms ICICI uses ("JAMMUANDKASHMIR" / "ANDHRAPRADESH"). */
const STATE_NAME_FORMS = {
  'tamil nadu':       ['tamil nadu', 'tamilnadu', 'tn'],
  'andhra pradesh':   ['andhra pradesh', 'andhrapradesh', 'andhra', 'ap', 'andra pradesh', 'andra'],
  'andra pradesh':    ['andhra pradesh', 'andhrapradesh', 'andhra', 'ap', 'andra pradesh', 'andra'],
  'telangana':        ['telangana', 'tg', 'ts'],
  'karnataka':        ['karnataka', 'ka'],
  'kerala':           ['kerala', 'kl'],
  'maharashtra':      ['maharashtra', 'mh'],
  'gujarat':          ['gujarat', 'gj'],
  'madhya pradesh':   ['madhya pradesh', 'madhyapradesh', 'mp'],
  'chhattisgarh':     ['chhattisgarh', 'chattisgarh', 'cg', 'ct'],
  'uttar pradesh':    ['uttar pradesh', 'up', 'up-east', 'up-west'],
  'uttarakhand':      ['uttarakhand', 'uk'],
  'rajasthan':        ['rajasthan', 'rj'],
  'punjab':           ['punjab', 'pb'],
  'haryana':          ['haryana', 'hr'],
  'himachal pradesh': ['himachal pradesh', 'himachalpradesh', 'hp'],
  'jammu and kashmir':['jammu and kashmir', 'jammu & kashmir', 'jammuandkashmir', 'jk', 'j&k'],
  'jammu & kashmir':  ['jammu and kashmir', 'jammu & kashmir', 'jammuandkashmir', 'jk', 'j&k'],
  'west bengal':      ['west bengal', 'wb'],
  'bihar':            ['bihar', 'br'],
  'jharkhand':        ['jharkhand', 'jh'],
  'odisha':           ['odisha', 'orissa', 'od', 'or'],
  'orissa':           ['odisha', 'orissa', 'od', 'or'],
  'delhi':            ['delhi', 'dl', 'ncr', 'delhi ncr'],
  'goa':              ['goa', 'ga'],
  'assam':            ['assam', 'as'],
  // Reverse: abbrev → forms (so a saved "TN" expands the same way)
  'tn': ['tamil nadu', 'tn'],
  'ap': ['andhra pradesh', 'ap'],
  'ts': ['telangana', 'ts', 'tg'],
  'tg': ['telangana', 'ts', 'tg'],
  'ka': ['karnataka', 'ka'],
  'kl': ['kerala', 'kl'],
  'mh': ['maharashtra', 'mh'],
  'gj': ['gujarat', 'gj'],
  'mp': ['madhya pradesh', 'mp'],
  'cg': ['chhattisgarh', 'cg'],
  'up': ['uttar pradesh', 'up', 'up-east', 'up-west'],
  'uk': ['uttarakhand', 'uk'],
  'rj': ['rajasthan', 'rj'],
  'pb': ['punjab', 'pb'],
  'hr': ['haryana', 'hr'],
  'hp': ['himachal pradesh', 'hp'],
  'jk': ['jammu and kashmir', 'jk'],
  'wb': ['west bengal', 'wb'],
  'br': ['bihar', 'br'],
  'jh': ['jharkhand', 'jh'],
  'od': ['odisha', 'od'],
  'or': ['odisha', 'or'],
  'dl': ['delhi', 'dl', 'ncr'],
  'ga': ['goa', 'ga'],
  'as': ['assam', 'as'],
  // "Rest of <state>" abbreviations used in commercial / TW rate cards.
  // Adding both directions so a saved cluster "Rest Of KA" matches a rule
  // region containing "ROK", and a margin scoped by state "Karnataka"
  // matches a rule whose region is "TN/ROK" (token expansion picks up
  // "rok" → karnataka).
  'rok':            ['rest of ka', 'rest of karnataka', 'rok', 'karnataka', 'ka'],
  'rest of ka':     ['rest of ka', 'rest of karnataka', 'rok', 'karnataka', 'ka'],
  'rest of karnataka': ['rest of ka', 'rest of karnataka', 'rok', 'karnataka', 'ka'],
  'rotn':           ['rest of tn', 'rest of tamil nadu', 'rotn', 'tamil nadu', 'tn'],
  'rest of tn':     ['rest of tn', 'rest of tamil nadu', 'rotn', 'tamil nadu', 'tn'],
  'roap':           ['rest of ap', 'rest of andhra pradesh', 'roap', 'andhra pradesh', 'andhra', 'ap'],
  'rest of ap':     ['rest of ap', 'rest of andhra pradesh', 'roap', 'andhra pradesh', 'andhra', 'ap'],
  'rotl':           ['rest of tl', 'rest of telangana', 'rotl', 'telangana', 'ts', 'tg'],
  'rest of tl':     ['rest of tl', 'rest of telangana', 'rotl', 'telangana', 'ts', 'tg'],
  'rom':            ['rest of mh', 'rest of maharashtra', 'rom', 'maharashtra', 'mh'],
  'rest of mh':     ['rest of mh', 'rest of maharashtra', 'rom', 'maharashtra', 'mh'],
  'rog':            ['rest of gj', 'rest of gujarat', 'rog', 'gujarat', 'gj'],
  'rest of gj':     ['rest of gj', 'rest of gujarat', 'rog', 'gujarat', 'gj'],
  'rest of gujarat':['rest of gj', 'rest of gujarat', 'rog', 'gujarat', 'gj'],
  'rowb':           ['rest of wb', 'rest of west bengal', 'rowb', 'west bengal', 'wb'],
  'rest of wb':     ['rest of wb', 'rest of west bengal', 'rowb', 'west bengal', 'wb'],
  'rest of west bengal': ['rest of wb', 'rest of west bengal', 'rowb', 'west bengal', 'wb'],
  'roup':           ['rest of up', 'rest of uttar pradesh', 'roup', 'uttar pradesh', 'up'],
  'rest of up':     ['rest of up', 'rest of uttar pradesh', 'roup', 'uttar pradesh', 'up'],
  'rest of mp':     ['rest of mp', 'rest of madhya pradesh', 'madhya pradesh', 'mp'],
  'rest of orissa': ['rest of orissa', 'rest of od', 'odisha', 'od', 'or'],
  'rest of assam':  ['rest of assam', 'rest of as', 'assam', 'as'],
  'rest of kl':     ['rest of kl', 'rest of kerala', 'kerala', 'kl'],
  'rest of kerala': ['rest of kl', 'rest of kerala', 'kerala', 'kl'],
  'rest of state':  ['rest of state', 'rest of'],
};

/** City → state map. Lets a margin scoped to "Karnataka" match a rate-rule
 *  whose region is "Bangalore", and vice versa. Many insurers (ICICI, TATA
 *  AIG, HDFC, SBI) name regions by major city instead of state. */
const CITY_TO_STATE = {
  // Karnataka
  'bangalore': 'karnataka', 'bengaluru': 'karnataka', 'mysore': 'karnataka',
  'mysuru': 'karnataka', 'mangalore': 'karnataka', 'belgaum': 'karnataka',
  'hubli': 'karnataka', 'tumkur': 'karnataka',
  // Tamil Nadu
  'chennai': 'tamil nadu', 'coimbatore': 'tamil nadu', 'madurai': 'tamil nadu',
  'salem': 'tamil nadu', 'trichy': 'tamil nadu', 'tiruchirapalli': 'tamil nadu',
  'tirunelveli': 'tamil nadu', 'tnref': 'tamil nadu',
  // Kerala
  'cochin': 'kerala', 'kochi': 'kerala', 'kozhikode': 'kerala',
  'calicut': 'kerala', 'trivandrum': 'kerala', 'thiruvananthapuram': 'kerala',
  'ernakulam': 'kerala', 'palakkad': 'kerala',
  // Andhra Pradesh
  'vijaywada': 'andhra pradesh', 'vijayawada': 'andhra pradesh',
  'visakhapatnam': 'andhra pradesh', 'vishakapattnam': 'andhra pradesh',
  'vishakhapatnam': 'andhra pradesh', 'tirupati': 'andhra pradesh',
  'guntur': 'andhra pradesh', 'nellore': 'andhra pradesh',
  'kurnool': 'andhra pradesh',
  // Telangana
  'hyderabad': 'telangana', 'secunderabad': 'telangana',
  'warangal': 'telangana', 'karimnagar': 'telangana',
  // Maharashtra
  'mumbai': 'maharashtra', 'pune': 'maharashtra', 'nagpur': 'maharashtra',
  'nashik': 'maharashtra', 'nasik': 'maharashtra', 'aurangabad': 'maharashtra',
  'thane': 'maharashtra',
  // Gujarat
  'ahmedabad': 'gujarat', 'ahemedabad': 'gujarat', 'surat': 'gujarat',
  'vadodara': 'gujarat', 'baroda': 'gujarat', 'rajkot': 'gujarat',
  'gandhinagar': 'gujarat',
  // Delhi NCR
  'delhi': 'delhi', 'ncr': 'delhi', 'janakpuri': 'delhi',
  // Haryana NCR
  'gurgaon': 'haryana', 'gurugram': 'haryana', 'faridabad': 'haryana',
  // Punjab
  'ludhiana': 'punjab', 'amritsar': 'punjab',
  // Chandigarh
  'chandigarh': 'chandigarh',
  // West Bengal
  'kolkata': 'west bengal', 'calcutta': 'west bengal', 'howrah': 'west bengal',
  'siliguri': 'west bengal',
  // UP
  'lucknow': 'uttar pradesh', 'kanpur': 'uttar pradesh',
  'varanasi': 'uttar pradesh', 'allahabad': 'uttar pradesh',
  'meerut': 'uttar pradesh', 'agra': 'uttar pradesh',
  'noida': 'uttar pradesh', 'ghaziabad': 'uttar pradesh',
  // Rajasthan
  'jaipur': 'rajasthan', 'jodhpur': 'rajasthan',
  'udaipur': 'rajasthan', 'kota': 'rajasthan',
  // MP
  'indore': 'madhya pradesh', 'bhopal': 'madhya pradesh',
  'gwalior': 'madhya pradesh', 'jabalpur': 'madhya pradesh',
  // Odisha
  'bhubaneshwar': 'odisha', 'bhubaneswar': 'odisha', 'cuttack': 'odisha',
  // Bihar
  'patna': 'bihar',
  // Assam
  'guwahati': 'assam', 'kamrup': 'assam', 'nagaon': 'assam',
  // Uttarakhand
  'dehradun': 'uttarakhand',
  // Jharkhand
  'ranchi': 'jharkhand', 'bokaro': 'jharkhand', 'jamshedpur': 'jharkhand',
};

// Inverse map — state → list of associated city tokens. Built once.
const STATE_TO_CITIES = (() => {
  const m = {};
  for (const [city, state] of Object.entries(CITY_TO_STATE)) {
    if (!m[state]) m[state] = [];
    m[state].push(city);
  }
  return m;
})();

/** City synonyms — different spellings of the SAME city. Used only when
 *  expanding a city-scoped margin so cluster='Bangalore' also matches a
 *  rule region of 'Bengaluru' (and vice versa). NEVER bridges to other
 *  cities — that would let cluster='Bangalore' cover 'Mysore'. */
const CITY_ALIASES = {
  'bangalore':       ['bangalore', 'bengaluru'],
  'bengaluru':       ['bangalore', 'bengaluru'],
  'cochin':          ['cochin', 'kochi', 'ernakulam'],
  'kochi':           ['cochin', 'kochi', 'ernakulam'],
  'ernakulam':       ['cochin', 'kochi', 'ernakulam'],
  'baroda':          ['baroda', 'vadodara'],
  'vadodara':        ['baroda', 'vadodara'],
  'visakhapatnam':   ['visakhapatnam', 'vishakapattnam', 'vishakapatnam', 'visakha', 'vishaka'],
  'vishakapattnam':  ['visakhapatnam', 'vishakapattnam', 'vishakapatnam', 'visakha', 'vishaka'],
  'vijayawada':      ['vijayawada', 'vijaywada'],
  'vijaywada':       ['vijayawada', 'vijaywada'],
  'mumbai':          ['mumbai', 'bombay'],
  'bombay':          ['mumbai', 'bombay'],
  'kolkata':         ['kolkata', 'calcutta'],
  'calcutta':        ['kolkata', 'calcutta'],
  'gurgaon':         ['gurgaon', 'gurugram'],
  'gurugram':        ['gurgaon', 'gurugram'],
  'thiruvananthapuram': ['thiruvananthapuram', 'trivandrum'],
  'trivandrum':      ['thiruvananthapuram', 'trivandrum'],
  'mysore':          ['mysore', 'mysuru'],
  'mysuru':          ['mysore', 'mysuru'],
  'bhubaneshwar':    ['bhubaneshwar', 'bhubaneswar'],
  'bhubaneswar':     ['bhubaneshwar', 'bhubaneswar'],
  'nashik':          ['nashik', 'nasik'],
  'nasik':           ['nashik', 'nasik'],
  'ahmedabad':       ['ahmedabad', 'ahemedabad'],
  'ahemedabad':      ['ahmedabad', 'ahemedabad'],
  'tiruchirapalli':  ['tiruchirapalli', 'trichy'],
  'trichy':          ['tiruchirapalli', 'trichy'],
};

/** Returns the lowercase forms a region-ish input expands to.
 *
 *  ASYMMETRIC by design — interprets state vs city differently:
 *
 *  • State input ('Karnataka' / 'KA' / 'tamil nadu') →
 *      ALL state forms + EVERY city in that state
 *      so a saved state margin covers all city-region rules under it
 *      (e.g. saved state='Karnataka' matches rules with region='Bangalore').
 *
 *  • City input ('Bangalore' / 'Cochin' / 'Mumbai') →
 *      ONLY that city + its spelling aliases (Bangalore↔Bengaluru, etc.)
 *      NEVER its sibling cities — a saved cluster='Bangalore' must NOT
 *      match a 'Mysore' rule even though both are in Karnataka.
 *      For city-not-given fall-through, the user just saves at the state
 *      level instead.
 *
 *  • Unknown input → returns as-is so plain substring match still works.
 */
function _stateForms(s) {
  const k = String(s || '').toLowerCase().trim();
  if (!k) return [];
  // State input — expand to forms + all cities under it.
  if (STATE_NAME_FORMS[k]) {
    const base = STATE_NAME_FORMS[k];
    const canonState = base.find(f => STATE_TO_CITIES[f]);
    const cities = canonState ? STATE_TO_CITIES[canonState] : [];
    return [...new Set([...base, ...cities])];
  }
  // City input — only the city + its spelling aliases.
  if (CITY_TO_STATE[k]) {
    return CITY_ALIASES[k] || [k];
  }
  return [k];
}

/** Whole-token check: does `haystack` contain `needle` as a standalone token
 *  (split on whitespace, slash, comma, hyphen, ampersand) OR as a literal
 *  substring? Substring catches "TamilNadu" → "tamilnadu", token catches
 *  "Tamil Nadu / Kerala" → "kerala". */
function _regionMatches(haystack, needle) {
  if (!haystack || !needle) return false;
  const h = String(haystack).toLowerCase();
  const n = String(needle).toLowerCase();
  if (h.includes(n)) return true;
  // Token match — split rule.region by common delimiters.
  const tokens = h.split(/[\s,/&\-_+]+/).filter(Boolean);
  return tokens.includes(n);
}

/** Does a saved-margin filter set "cover" a rate_rule row? Uses the same
 *  semantics as policyMatchesMargin (string OR array, OR-match) but checks
 *  against rule.region/segment/etc. instead of policy params. Margins with
 *  no filter set never match anything. */
function marginCoversRateRule(filters, rule) {
  if (!filters || Object.keys(filters).length === 0) return false;
  const f = filters;
  if (f.searchInsurer) {
    if (canonInsurer(f.searchInsurer) !== canonInsurer(rule.insurer)) return false;
  }
  if (f.searchProduct) {
    const wantList = Array.isArray(f.searchProduct) ? f.searchProduct : [f.searchProduct];
    const have = normVtype(rule.product);
    if (!wantList.some(p => normVtype(p) === have)) return false;
  }
  // Generic catchall regions ("All", "All RTOs", "Pan India", "Others",
  // "Bad locations" etc.) describe rules that apply EVERYWHERE for the
  // insurer. A state-specific saved margin should still apply to such
  // rules — skip the geo filters when the rule's region is generic.
  // (See HDFC PCV grid where catchall + state-in-remarks is the schema.)
  const _GENERIC_REGION_TOKENS = new Set([
    'all', 'all rtos', 'all excluding declined rtos', 'pan india',
    'others', 'others 2', 'rest of state',
    'bad', 'good', 'bad locations', 'good locations',
    'rog location', 'rog bad locations',
  ]);
  const _isGenericRegion = (r) => _GENERIC_REGION_TOKENS.has(String(r || '').trim().toLowerCase());
  const skipGeo = _isGenericRegion(rule.region);

  // Region/State/City all check against rule.region. State / city values
  // get expanded to all known forms (so "TN" matches "Tamil Nadu" and vice
  // versa); plain Cluster does substring + token match only.
  // OR-match across the array values; AND across the three keys.
  if (f.searchCluster && !skipGeo) {
    const wantList = (Array.isArray(f.searchCluster) ? f.searchCluster : [f.searchCluster])
      .filter(Boolean);
    if (wantList.length > 0) {
      const have = rule.region || '';
      const anyHit = wantList.some(w => {
        // For state-ish values in cluster (the upload uses TN/KA/etc. for RTO too),
        // fall through state-form expansion as well.
        const forms = _stateForms(w);
        return forms.some(form => _regionMatches(have, form));
      });
      if (!anyHit) return false;
    }
  }
  if (f.searchState && !skipGeo) {
    const wantList = (Array.isArray(f.searchState) ? f.searchState : [f.searchState])
      .filter(Boolean);
    if (wantList.length > 0) {
      const have = rule.region || '';
      const anyHit = wantList.some(w => {
        const forms = _stateForms(w);
        return forms.some(form => _regionMatches(have, form));
      });
      if (!anyHit) return false;
    }
  }
  if (f.searchCity && !skipGeo) {
    const wantList = (Array.isArray(f.searchCity) ? f.searchCity : [f.searchCity])
      .filter(Boolean);
    if (wantList.length > 0) {
      const have = rule.region || '';
      if (!wantList.some(w => _regionMatches(have, w))) return false;
    }
  }
  if (f.searchVehicleCategory) {
    const wantList = (Array.isArray(f.searchVehicleCategory) ? f.searchVehicleCategory : [f.searchVehicleCategory])
      .map(v => String(v || '').toLowerCase()).filter(Boolean);
    const have = String(rule.segment || '').toLowerCase();
    // TW sub-category match — many insurers (Reliance, Chola) use a single
    // "TW" segment as the catchall (= bike + everything-not-scooter) and
    // only break Scooter / Moped out explicitly. So:
    //   • Bike    → segment explicitly says bike/motorcycle/mc, OR is plain
    //               TW with no scooter/moped marker (catchall)
    //   • Scooter → segment explicitly says scooter / scooty / SC, OR moped
    //               (Moped is treated as a Scooter variant — saved Scooter
    //               margins cover both, and vice versa)
    //   • Moped   → same as Scooter (interchangeable)
    // Other categories fall through to plain substring (handles MISC sub-
    // categories like "tractor", PCV "school bus", etc.).
    const isProductTw = /^(TW|2W|TW_EV)$/i.test(String(rule.product || ''));
    const isExplicitBike    = /\b(bike|motorcycle|motor\s*cycle|mc)\b/i.test(have);
    const isExplicitScooter = /\b(scooter|scooty|sc)\b/i.test(have);
    const isExplicitMoped   = /\b(moped)\b/i.test(have);
    // Moped ≡ Scooter for matching purposes — covers either-or-both.
    const isScooterOrMoped  = isExplicitScooter || isExplicitMoped;
    const anyHit = wantList.some(w => {
      if (w === 'bike') {
        if (isExplicitBike) return true;
        // TW catchall (segment is TW alone, no sub-category marker)
        if (isProductTw && !isScooterOrMoped) return true;
        return false;
      }
      if (w === 'scooter' || w === 'moped') return isScooterOrMoped;
      // Any other category — fall through to substring match (handles
      // tractor/excavator/school bus/taxi/etc.).
      return have.includes(w);
    });
    if (!anyHit) return false;
  }
  if (f.searchMake) {
    // Normalise both sides: strip OEM-style suffixes and bike-business
    // qualifiers ("MOTORCYCLE", "MOTORS", "AUTO") so "Hero OEM" ↔ "Hero",
    // "Honda Motorcycle" ↔ "Honda", "Bajaj Auto" ↔ "Bajaj" all collide.
    const _normMake = (s) => String(s || '')
      .toUpperCase()
      .replace(/\b(OEM|MOTORS?|MOTORCYCLE|AUTO|INDIA(?:N)?|LTD|LIMITED|PVT|PRIVATE|CO|COMPANY)\b/g, '')
      .replace(/[^A-Z0-9 ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const want = _normMake(f.searchMake);
    const have = _normMake(rule.make);
    if (!want) {
      // saved make degenerated to nothing — skip the filter
    } else if (!have) {
      return false; // rule has no make / generic
    } else {
      // Match as either side substring of the other (handles "ROYAL ENFIELD" ↔ "ROYAL")
      if (!have.includes(want) && !want.includes(have)) return false;
    }
  }
  if (f.searchFuelType) {
    const want = String(f.searchFuelType).toUpperCase();
    const have = String(rule.fuel_type || '').toUpperCase();
    // Catchall: rule with no fuel_type applies to all fuels.
    if (have && !have.includes(want)) return false;
  }
  // CC band overlap. Saved range is [searchCcMin..searchCcMax] (each side
  // null = unbounded). Rule range is [cc_band_min..cc_band_max] same convention.
  // Catchall: if the rule has no CC band, treat as covering all CC.
  if (f.searchCcMin != null || f.searchCcMax != null) {
    const ruleMin = rule.cc_band_min;
    const ruleMax = rule.cc_band_max;
    if (ruleMin != null || ruleMax != null) {
      const wMin = f.searchCcMin != null ? Number(f.searchCcMin) : -Infinity;
      const wMax = f.searchCcMax != null ? Number(f.searchCcMax) :  Infinity;
      const hMin = ruleMin != null ? Number(ruleMin) : -Infinity;
      const hMax = ruleMax != null ? Number(ruleMax) :  Infinity;
      // No overlap when one range ends before the other begins.
      if (wMax < hMin || wMin > hMax) return false;
    }
  }
  return true;
}

/** Build the dedup key the Excel export uses to collapse rows that differ
 *  only in rate_type / rate_value (e.g. Digit's 1+1 / 1+3 / 1+5 / 2+2 /
 *  3+3 / 5+5 tenure variants). All rate_rules sharing this key produce
 *  one Excel row. Used by the consolidated coverage count so the card
 *  matches the .xlsx row count. */
function rateRuleConsolidationKey(r) {
  return [
    r.insurer, r.product, r.region, r.segment, r.sub_type, r.make,
    r.fuel_type, r.addon, r.carrier_type,
    r.vehicle_age_min, r.vehicle_age_max,
    r.weight_band_min, r.weight_band_max,
    r.cc_band_min,    r.cc_band_max,
    r.seating_capacity_min, r.seating_capacity_max,
  ].map(v => v == null ? '' : String(v)).join('');
}

/** GET /coverage?insurer=X[,Y]&product=A[,B][&consolidated=true]
 *  How many rate rules are covered by at least one saved margin vs pending.
 *  Both query params are optional and accept a comma-separated list.
 *  When `consolidated=true`, counts post-dedup tuples (same logic the Excel
 *  export uses to collapse tenure-variant rows) so the number matches the
 *  .xlsx row count. Returns overall totals plus per-insurer and per-product
 *  breakdowns so the UI can render a small summary table. */
router.get('/coverage', async (req, res, next) => {
  try {
    const insurerFilter = String(req.query.insurer || '').split(',').map(s => s.trim()).filter(Boolean);
    const productFilter = String(req.query.product || '').split(',').map(s => s.trim()).filter(Boolean);
    const consolidated  = String(req.query.consolidated || '').toLowerCase() === 'true';

    const pool = await getPool();

    // Load all active margin rules — small table, holds a few hundred rows
    // at most.
    const mr = await pool.request().query(
      `SELECT id, filters_json FROM margin_rules WHERE active = 1`
    );
    const margins = mr.recordset.map(row => {
      let filters = {};
      try { filters = JSON.parse(row.filters_json || '{}') || {}; } catch { /* keep empty */ }
      return { id: row.id, filters };
    });

    // Pull rate-rule columns we need for coverage matching. When consolidated
    // mode is on we also need the band columns so the dedup key can be built.
    const conds = [];
    const rq = pool.request();
    if (insurerFilter.length > 0) {
      const placeholders = insurerFilter.map((v, i) => { rq.input('ins' + i, sql.NVarChar(100), v); return '@ins' + i; });
      conds.push(`insurer IN (${placeholders.join(',')})`);
    }
    if (productFilter.length > 0) {
      const placeholders = productFilter.map((v, i) => { rq.input('prod' + i, sql.NVarChar(50), v); return '@prod' + i; });
      conds.push(`product IN (${placeholders.join(',')})`);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const selectCols = consolidated
      ? `id, insurer, product, region, segment, sub_type, make, fuel_type, addon, carrier_type,
         vehicle_age_min, vehicle_age_max, weight_band_min, weight_band_max,
         cc_band_min, cc_band_max, seating_capacity_min, seating_capacity_max`
      : `id, insurer, product, region, segment, fuel_type, make`;
    const rr = await rq.query(`SELECT ${selectCols} FROM rate_rules ${where}`);
    const rateRules = rr.recordset;

    let withMargin = 0;
    const byInsurer = new Map();
    const byProduct = new Map();

    if (consolidated) {
      // Collapse rate_rules by the same key the Excel export uses, then
      // count groups (= .xlsx rows) and per-group coverage. A group counts
      // as "with margin" when ANY underlying rule is covered by a saved
      // margin (since the merged row in the .xlsx will display that margin).
      const groups = new Map();
      for (const rule of rateRules) {
        const k = rateRuleConsolidationKey(rule);
        if (!groups.has(k)) groups.set(k, { rep: rule, covered: false });
        const g = groups.get(k);
        if (!g.covered && margins.some(m => marginCoversRateRule(m.filters, rule))) {
          g.covered = true;
        }
      }
      for (const g of groups.values()) {
        if (g.covered) withMargin++;
        const ik = g.rep.insurer || '(unknown)';
        if (!byInsurer.has(ik)) byInsurer.set(ik, { insurer: ik, total: 0, with_margin: 0 });
        byInsurer.get(ik).total++;
        if (g.covered) byInsurer.get(ik).with_margin++;
        const pk = g.rep.product || '(none)';
        if (!byProduct.has(pk)) byProduct.set(pk, { product: pk, total: 0, with_margin: 0 });
        byProduct.get(pk).total++;
        if (g.covered) byProduct.get(pk).with_margin++;
      }
      const finalize = (rows) => rows.map(r => ({
        ...r, pending: r.total - r.with_margin,
      })).sort((a, b) => b.total - a.total);
      return res.json({
        success: true,
        consolidated: true,
        filters: { insurer: insurerFilter, product: productFilter },
        total: groups.size,
        with_margin: withMargin,
        pending: groups.size - withMargin,
        raw_total: rateRules.length,
        saved_margin_count: margins.length,
        by_insurer: finalize([...byInsurer.values()]),
        by_product: finalize([...byProduct.values()]),
      });
    }

    // Default mode — count raw rate_rules.
    for (const rule of rateRules) {
      const covered = margins.some(m => marginCoversRateRule(m.filters, rule));
      if (covered) withMargin++;
      const ik = rule.insurer || '(unknown)';
      if (!byInsurer.has(ik)) byInsurer.set(ik, { insurer: ik, total: 0, with_margin: 0 });
      byInsurer.get(ik).total++;
      if (covered) byInsurer.get(ik).with_margin++;
      const pk = rule.product || '(none)';
      if (!byProduct.has(pk)) byProduct.set(pk, { product: pk, total: 0, with_margin: 0 });
      byProduct.get(pk).total++;
      if (covered) byProduct.get(pk).with_margin++;
    }
    const finalize = (rows) => rows.map(r => ({
      ...r, pending: r.total - r.with_margin,
    })).sort((a, b) => b.total - a.total);

    res.json({
      success: true,
      consolidated: false,
      filters: { insurer: insurerFilter, product: productFilter },
      total: rateRules.length,
      with_margin: withMargin,
      pending: rateRules.length - withMargin,
      saved_margin_count: margins.length,
      by_insurer: finalize([...byInsurer.values()]),
      by_product: finalize([...byProduct.values()]),
    });
  } catch (err) { next(err); }
});

/** GET /coverage/pending?insurer=X[,Y]&product=A[,B] — list rate rules NOT
 *  covered by any saved margin, grouped by (segment, region) so the user
 *  can see at a glance what's still missing and act on the biggest buckets
 *  first. Same insurer/product comma-list filters as /coverage above. */
router.get('/coverage/pending', async (req, res, next) => {
  try {
    const insurerFilter = String(req.query.insurer || '').split(',').map(s => s.trim()).filter(Boolean);
    const productFilter = String(req.query.product || '').split(',').map(s => s.trim()).filter(Boolean);

    const pool = await getPool();

    const mr = await pool.request().query(
      `SELECT id, filters_json FROM margin_rules WHERE active = 1`
    );
    const margins = mr.recordset.map(row => {
      let filters = {};
      try { filters = JSON.parse(row.filters_json || '{}') || {}; } catch { /* keep empty */ }
      return { id: row.id, filters };
    });

    const conds = [];
    const rq = pool.request();
    if (insurerFilter.length > 0) {
      const placeholders = insurerFilter.map((v, i) => { rq.input('ins' + i, sql.NVarChar(100), v); return '@ins' + i; });
      conds.push(`insurer IN (${placeholders.join(',')})`);
    }
    if (productFilter.length > 0) {
      const placeholders = productFilter.map((v, i) => { rq.input('prod' + i, sql.NVarChar(50), v); return '@prod' + i; });
      conds.push(`product IN (${placeholders.join(',')})`);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const rr = await rq.query(
      `SELECT id, insurer, product, region, segment, fuel_type, make
       FROM rate_rules ${where}`
    );

    // Group pending rules by (insurer, product, segment, region) — that's the
    // tuple the user typically scopes a margin to anyway.
    const groups = new Map();
    let totalPending = 0;
    for (const rule of rr.recordset) {
      if (margins.some(m => marginCoversRateRule(m.filters, rule))) continue;
      totalPending++;
      const key = [
        rule.insurer || '?',
        rule.product || '?',
        rule.segment || '(none)',
        rule.region  || '(none)',
      ].join('||');
      if (!groups.has(key)) {
        groups.set(key, {
          insurer: rule.insurer, product: rule.product,
          segment: rule.segment || '(none)', region: rule.region || '(none)',
          count: 0,
        });
      }
      groups.get(key).count++;
    }
    // Sort biggest buckets first so the user sees where the gap concentrates.
    const list = [...groups.values()].sort((a, b) => b.count - a.count);

    res.json({
      success: true,
      filters: { insurer: insurerFilter, product: productFilter },
      total_pending: totalPending,
      group_count: list.length,
      groups: list,
    });
  } catch (err) { next(err); }
});

/** DELETE /:id — soft-delete (active = 0). */
router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, error: 'invalid id' });
    }
    const pool = await getPool();
    await pool.request()
      .input('id', sql.Int, id)
      .query(`UPDATE margin_rules SET active = 0, updated_at = GETDATE() WHERE id = @id`);
    res.json({ success: true });
  } catch (err) { next(err); }
});

/** ─── Bulk margin upload ──────────────────────────────────────────────────
 *  Accepts an Excel sheet of margin rules in the operations team's format:
 *    Header row:   Insurance Name | Segment | Plan | Cubic Capacity |
 *                  Condition | RTO | State | On Pay | Margin
 *  The header may sit at any row in the sheet (the parser scans for it).
 *  Each subsequent row becomes one margin_rule with the corresponding
 *  filter fields populated. Existing rules with the same filter signature
 *  are updated; rows that fail to parse are reported back as errors.
 */

// Insurance Name → existing slug (mirrors resolveInsurerSlug in routes/policy.js
// + the parseChatQuery list in public/index.html). Keys are uppercased trimmed.
const _UPLOAD_INSURER_MAP = {
  'RELIANCE': 'reliance',
  'BAJAJ': 'bajaj_allianz',
  'BAJAJ ALLIANZ': 'bajaj_allianz',
  'CHOLA': 'chola_ms',
  'CHOLAMANDALAM': 'chola_ms',
  'CHOLA MS': 'chola_ms',
  'GO DIGIT': 'go_digit',
  'DIGIT': 'go_digit',
  'HDFC': 'hdfc_ergo',
  'HDFC ERGO': 'hdfc_ergo',
  'ERGO': 'hdfc_ergo',
  'LIBERTY': 'liberty',
  'LOMBARD': 'icici_lombard',
  'ICICI': 'icici_lombard',
  'ICICI LOMBARD': 'icici_lombard',
  'MAGMA': 'magma',
  'TATA AIG': 'tata_aig',
  'TATA': 'tata_aig',
  'AIG': 'tata_aig',
  'ROYAL SUNDARAM': 'royal_sundaram',
  'ROYAL': 'royal_sundaram',
  'SUNDARAM': 'royal_sundaram',
  'SBI': 'sbi_general',
  'SBI GENERAL': 'sbi_general',
  'IFFCO': 'iffco_tokio',
  'IFFCO TOKIO': 'iffco_tokio',
  'UNIVERSAL SOMPO': 'universal_sompo',
  'UNIVERSAL': 'universal_sompo',
  'SOMPO': 'universal_sompo',
  'NEW INDIA': 'new_india',
  'NATIONAL': 'national',
  'ORIENTAL': 'oriental',
  'UNITED INDIA': 'united_india',
  'KOTAK': 'kotak',
  'NAVI': 'navi',
  'ACKO': 'acko',
  'FUTURE GENERALI': 'future_generali',
  'FUTURE': 'future_generali',
  'GENERALI': 'future_generali',
  'SHRIRAM': 'shriram',
  'ZUNO': 'zuno',
  'EDELWEISS': 'zuno',
  'RAHEJA QBE': 'raheja_qbe',
  'RAHEJA': 'raheja_qbe',
};

/** Plan column → ins_product (Comp / SAOD / TP). Bundled & long-tenure are
 *  treated as Comp. */
function _planToInsProduct(plan) {
  const p = String(plan || '').toUpperCase().replace(/\s+/g, ' ').trim();
  if (!p || p === '-') return null;
  if (/SAOD/.test(p)) return 'SAOD';
  if (/THIRD\s*PARTY|^TP$|SATP/.test(p)) return 'TP';
  if (/COMP|BUNDLED|PACKAGE|1\+1|1\+5|3\+3|5\+5/.test(p)) return 'Comp';
  return null;
}

/** Segment column → vehicle category label that matches rate_rules.segment
 *  substring conventions (BIKE / SCOOTER / Moped). */
function _segmentToCategory(seg) {
  const s = String(seg || '').toUpperCase().trim();
  if (!s || s === '-') return null;
  if (/BIKE|MOTOR\s*CYCLE|MC\b/.test(s)) return 'Bike';
  if (/SCOOTER|SCOOTY|SC\b/.test(s)) return 'Scooter';
  if (/MOPED/.test(s)) return 'Moped';
  return null;
}

/** Condition column is mostly a make name (Honda / TVS / Yamaha / KTM).
 *  When it parses to a known make, return the trimmed UPPERCASE token —
 *  blank/dash/sentence text stays null (those go into the description). */
function _conditionToMake(cond) {
  const c = String(cond || '').trim();
  if (!c || c === '-') return null;
  // Accept single-word brand names; anything with sentence punctuation falls through.
  const KNOWN_MAKES = ['HONDA','HMSI','TVS','YAMAHA','KTM','BAJAJ','HERO','SUZUKI',
                       'ROYAL ENFIELD','HARLEY','VESPA','APRILIA','DUCATI','BENELLI',
                       'JAWA','HMC','MAHINDRA','TATA','MARUTI'];
  const u = c.toUpperCase();
  for (const m of KNOWN_MAKES) {
    if (u === m || u.startsWith(m + ' ') || u.endsWith(' ' + m) ||
        u === m.replace(' ', '')) {
      return m;
    }
  }
  return null;
}

/** Regional wildcards used in margin sheets — "All South RTO" / "South" /
 *  "All North RTO" / etc. Each maps to the canonical state list. */
const _REGIONAL_GROUPS = {
  SOUTH:     ['Tamil Nadu', 'Karnataka', 'Kerala', 'Andhra Pradesh', 'Telangana', 'Puducherry'],
  NORTH:     ['Delhi', 'Haryana', 'Punjab', 'Himachal Pradesh', 'Jammu and Kashmir', 'Rajasthan', 'Uttar Pradesh', 'Uttarakhand', 'Chandigarh'],
  WEST:      ['Maharashtra', 'Gujarat', 'Goa', 'Daman and Diu', 'Dadra and Nagar Haveli'],
  EAST:      ['West Bengal', 'Bihar', 'Jharkhand', 'Odisha', 'Sikkim'],
  NORTHEAST: ['Assam', 'Arunachal Pradesh', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Tripura'],
  CENTRAL:   ['Madhya Pradesh', 'Chhattisgarh'],
  // "All India" / "PAN India" expands to nothing — leave as no state filter
  // so the rule covers everywhere (broader than any region group).
};

/** State / RTO column expander. Returns:
 *   - String for a single canonical state name ("Tamil Nadu")
 *   - Array of canonical state names for multi-state / regional wildcards
 *   - null when no useful filter can be inferred (e.g. "Pan India" → match all)
 *  Handles:
 *   - State abbreviations: TN / KA / AP / TS / TG / MH / GJ / UP / HR / DL / etc.
 *   - Multi-state with separators: "AP,TS", "TN+KL", "MH/GJ"
 *   - Regional wildcards: "All South RTO", "South", "All North RTO", "All East RTO"
 *   - "All <STATE_ABBR>" (e.g. "All KA") → just that state
 */
function _expandState(s) {
  const raw = String(s || '').trim();
  const u = raw.toUpperCase();
  if (!u || u === '-') return null;
  const map = {
    'AP': 'Andhra Pradesh', 'TS': 'Telangana', 'TG': 'Telangana',
    'KA': 'Karnataka', 'KL': 'Kerala', 'TN': 'Tamil Nadu',
    'MH': 'Maharashtra', 'GJ': 'Gujarat', 'UP': 'Uttar Pradesh',
    'HR': 'Haryana', 'DL': 'Delhi', 'PB': 'Punjab', 'RJ': 'Rajasthan',
    'MP': 'Madhya Pradesh', 'CG': 'Chhattisgarh', 'CT': 'Chhattisgarh',
    'WB': 'West Bengal', 'BR': 'Bihar', 'JH': 'Jharkhand',
    'OD': 'Odisha', 'OR': 'Odisha', 'AS': 'Assam', 'GA': 'Goa',
    'JK': 'Jammu and Kashmir', 'HP': 'Himachal Pradesh', 'UK': 'Uttarakhand',
    'CH': 'Chandigarh',
  };
  if (map[u]) return map[u];
  // Regional wildcards — match "South", "South RTO", "All South RTO", "South India", etc.
  for (const [region, states] of Object.entries(_REGIONAL_GROUPS)) {
    const re = new RegExp(`(^|\\b)(?:ALL\\s+)?${region}(?:\\s+(?:RTO|INDIA|ZONE))?($|\\b)`, 'i');
    if (re.test(u)) return states.length === 1 ? states[0] : states;
  }
  // "All <state-abbrev>" → just that state.
  const allStateMatch = u.match(/^ALL\s+([A-Z]{2,3})\s*(?:RTO)?$/);
  if (allStateMatch && map[allStateMatch[1]]) return map[allStateMatch[1]];
  // Multi-state cells like "AP,TS" / "TN+KL" / "MH/GJ" → array.
  if (/[,/+&]/.test(u)) {
    const parts = u.split(/[,/+&]/).map(p => p.trim()).filter(Boolean);
    const expanded = [];
    for (const p of parts) {
      // Each part might itself be a regional wildcard
      const ex = _expandState(p);
      if (Array.isArray(ex)) expanded.push(...ex);
      else if (ex) expanded.push(ex);
    }
    if (expanded.length === 0) return null;
    return expanded.length === 1 ? expanded[0] : [...new Set(expanded)];
  }
  return null; // Free-text we don't know how to expand — caller handles.
}

/** Parse the "Cubic Capacity" column from a margin upload row.
 *  Returns { ccMin, ccMax, fuelOverride } where ccMin/Max are integers
 *  (or null = no bound on that side) and fuelOverride is set when the
 *  cell is a fuel filter masquerading as CC (e.g. "EV").
 *  Recognised forms (case-insensitive):
 *     ""  "-"  "All CC"  "All CC & EV"  → no constraint
 *     "EV"                              → fuel='Electric'
 *     "Up to 350" / "Below 350" / "<= 350" / "Below155"  → max=350
 *     "> 350 CC" / "Above 350" / "Above155"              → min=351
 *     "150 to 350" / "150-350" / "180-350" / ">75-150 CC" → range
 */
function _parseCcCell(raw) {
  const s = String(raw || '').trim();
  if (!s || s === '-' || /^all\s*cc(?:\s*&\s*ev)?$/i.test(s)) return { ccMin: null, ccMax: null };
  if (/^ev$|^electric$/i.test(s)) return { ccMin: null, ccMax: null, fuelOverride: 'Electric' };
  const u = s.replace(/cc/gi, '').replace(/\s+/g, ' ').trim();

  // Range: "150 to 350" / "150-350" / ">75-150"
  let m = u.match(/^>?\s*(\d+)\s*(?:to|-|–)\s*(\d+)\s*$/i);
  if (m) return { ccMin: parseInt(m[1], 10), ccMax: parseInt(m[2], 10) };

  // ">N" / "Above N" / ">=N"
  m = u.match(/^(?:>|>=|above)\s*(\d+)\s*\+?\s*$/i);
  if (m) return { ccMin: parseInt(m[1], 10), ccMax: null };

  // "<N" / "Below N" / "<=N" / "Up to N" / "BelowN" / "AboveN"
  m = u.match(/^(?:<|<=|below|upto|up\s*to)\s*(\d+)\s*$/i);
  if (m) return { ccMin: null, ccMax: parseInt(m[1], 10) };
  // "Below155" with no space
  m = u.match(/^below\s*(\d+)$/i);
  if (m) return { ccMin: null, ccMax: parseInt(m[1], 10) };
  m = u.match(/^above\s*(\d+)$/i);
  if (m) return { ccMin: parseInt(m[1], 10), ccMax: null };

  return { ccMin: null, ccMax: null };
}

/** Coverage-type / Plan cell → array of ins_product tokens. Operations sheets
 *  cram multiple coverages into one cell — "Comp/Third Party",
 *  "Comprehensive/SAOD", "Bundled 1+3,Comprehensive1+1, SAOD" — and we need
 *  to fan them out into separate margin rules.
 *  Returns [] when the cell carries no recognised coverage tokens. */
function _coverageTypeToInsProducts(plan) {
  const p = String(plan || '').toUpperCase().replace(/\s+/g, ' ').trim();
  if (!p || p === '-') return [];
  const out = new Set();
  // "Third Party" / "TP" / "SATP"
  if (/THIRD\s*PARTY|\bTP\b|\bSATP\b|LIABILITY/.test(p)) out.add('TP');
  // "SAOD"
  if (/\bSAOD\b/.test(p)) out.add('SAOD');
  // "Comp" / "Comprehensive" / "Bundled" / "Package" / tenure forms
  if (/COMP|BUNDLED|PACKAGE|1\+1|1\+3|1\+5|2\+2|3\+3|5\+5/.test(p)) out.add('Comp');
  return [...out];
}

/** Insurer cell parser. Some sheets (e.g. GJ "CV 4W") pack the insurer name,
 *  tonnage band, and sometimes seating capacity into ONE column —
 *    "Chola Upto 3.5T", "HDFC 2.5T-3.5T", "Bajaj (6+1)",
 *    "Shriram 7501 To 42500T" (kg!), "Royal Sundaram 0 To 2300T" (kg)
 *  Returns { slug, tonMin, tonMax, seatingMin, seatingMax, sectionDivider }.
 *  When the cell is a section heading ("Tractor", "School BUS", "INSURANCE
 *  COMPANY") rather than a real insurer row, sectionDivider=true so the
 *  caller can skip silently without an error. */
function _parseInsurerCell(raw) {
  const out = { slug: null, tonMin: null, tonMax: null, seatingMin: null, seatingMax: null, sectionDivider: false };
  let s = String(raw || '').trim();
  if (!s) { out.sectionDivider = true; return out; }
  // Section headers / dividers — not insurer rows at all.
  const SECTION_HEADERS = new Set([
    'INSURANCE COMPANY', 'INSURER', 'INSURANCE NAME',
    'TRACTOR', 'SCHOOL BUS', 'STAFF BUS', 'TAXI', 'MISC-D VEHICLES',
    'MISC D VEHICLES', 'MISCELLANEOUS', 'MISC',
  ]);
  const upRaw = s.toUpperCase().trim();
  if (SECTION_HEADERS.has(upRaw)) { out.sectionDivider = true; return out; }
  // "GCV 3.5 Tone To 7.5 Tone" / "GCV Above 12000 Tone" — sheet-internal
  // sub-section dividers, not insurer rows.
  if (/^(GCV|PCV|MISC|TW|CAR|PVT\s*CAR)\s+(UPTO|UP\s*TO|ABOVE|>|<|\d)/i.test(upRaw)) {
    out.sectionDivider = true; return out;
  }

  // Strip seating tokens like "(6+1)", "(4+1)", "(7-10)" and capture them.
  s = s.replace(/\(\s*(\d+)\s*\+\s*1\s*\)/i, (_, n) => {
    out.seatingMin = parseInt(n, 10) + 1;
    out.seatingMax = parseInt(n, 10) + 1;
    return ' ';
  });
  s = s.replace(/\(\s*(\d+)\s*[-–]\s*(\d+)\s*\)/, (_, a, b) => {
    out.seatingMin = parseInt(a, 10);
    out.seatingMax = parseInt(b, 10);
    return ' ';
  });

  // Strip a trailing dash sometimes used after the brand ("Icici Lombard- 2450T").
  s = s.replace(/-+\s*/g, ' ').replace(/\s+/g, ' ').trim();

  // Capture tonnage band tokens at the END of the cell. Numbers > 100 are
  // treated as kilograms (Shriram + ICICI use both kg and tonnes); we
  // normalise to tonnes by dividing by 1000 when ANY number in the range
  // exceeds 100.
  const N = `\\d+(?:\\.\\d+)?`;
  const TON_PATTERNS = [
    // "X To Y T" / "X to Y T" / "X-Y T" / "X – Y T"
    new RegExp(`\\s+(${N})\\s*T?\\s*(?:TO|[-–])\\s*(${N})\\s*T?\\s*$`, 'i'),
    // "Upto N T" / "Up to N T"
    new RegExp(`\\s+(?:UPTO|UP\\s*TO)\\s*(${N})\\s*T?\\s*$`, 'i'),
    // "Above N T" / "> N T"
    new RegExp(`\\s+(?:ABOVE|>)\\s*(${N})\\s*T?\\s*$`, 'i'),
  ];
  let m;
  if ((m = s.match(TON_PATTERNS[0]))) {
    let a = parseFloat(m[1]); let b = parseFloat(m[2]);
    if (a > 100 || b > 100) { a = a / 1000; b = b / 1000; }
    out.tonMin = a; out.tonMax = b;
    s = s.slice(0, m.index).trim();
  } else if ((m = s.match(TON_PATTERNS[1]))) {
    let a = parseFloat(m[1]);
    if (a > 100) a = a / 1000;
    out.tonMax = a;
    s = s.slice(0, m.index).trim();
  } else if ((m = s.match(TON_PATTERNS[2]))) {
    let a = parseFloat(m[1]);
    if (a > 100) a = a / 1000;
    out.tonMin = a;
    s = s.slice(0, m.index).trim();
  }

  // Strip a stray trailing "T" left behind by patterns like "Above40T" with
  // no space before the number.
  s = s.replace(/\s+T$/i, '').trim();
  // Strip any leftover trailing words like "ONLY" / "EV ONLY" — just keep
  // whatever's left as the candidate insurer name.
  const candidate = s.replace(/\s+(EV\s+ONLY|ONLY|FUEL)$/i, '').trim();

  const lookup = candidate.toUpperCase();
  if (_UPLOAD_INSURER_MAP[lookup]) { out.slug = _UPLOAD_INSURER_MAP[lookup]; return out; }
  // Try progressively shorter prefixes — handles "Royal Sundaram" → "ROYAL"
  // when that's the longest map entry that matches.
  const tokens = lookup.split(/\s+/).filter(Boolean);
  for (let n = tokens.length; n >= 1; n--) {
    const k = tokens.slice(0, n).join(' ');
    if (_UPLOAD_INSURER_MAP[k]) { out.slug = _UPLOAD_INSURER_MAP[k]; return out; }
  }
  return out;
}

/** Vehicle Category cell → { product, category, tonMin, tonMax }.
 *  Recognises the wide variety of category labels used across margin sheets:
 *    "GCV Upto 2.5T" / "GCV 2.5T - 3.5T" / "GCV 3.5T - 7.5T" / "GCV Upto 7.5T"
 *    "GCV 3W" / "PCV 3W" / "GCV Upto 12T" / "GCV Upto 16T" / "GCV >40T"
 *    "Pvt Car" / "PCV" / "MISC" / "MIS"
 *    "BIKE" / "SCOOTER" / "Moped"
 *  Returns nulls when the cell has nothing useful. */
function _parseCategoryCell(raw) {
  const s = String(raw || '').toUpperCase().replace(/\s+/g, ' ').trim();
  const out = { product: null, category: null, tonMin: null, tonMax: null };
  if (!s || s === '-') return out;
  // 3W variants — keep as PCV/GCV product, no tonnage filter (3W has no
  // weight band). We don't surface "3W" as searchVehicleCategory because
  // it'd narrow further than rate cards usually go for 3-wheelers.
  if (/^(GCV|PCV)\s*[-_ ]?3W\b/.test(s) || /\b3\s*W\b/.test(s)) {
    if (/PCV/.test(s)) out.product = 'PCV';
    else if (/GCV/.test(s)) out.product = 'GCV';
    else out.product = 'GCV'; // bare "3W" defaults to GCV-3W
    return out;
  }
  // GCV with tonnage
  if (/^GCV\b/.test(s)) {
    out.product = 'GCV';
    let m;
    // "GCV Upto 2.5T" / "GCV UPTO 12 T" / "GCV up to 7.5T"
    if ((m = s.match(/UPTO\s*(\d+(?:\.\d+)?)\s*T/i))) out.tonMax = parseFloat(m[1]);
    // "GCV 2.5T - 3.5T" / "GCV 2.5 - 3.5T" / "GCV 2.5T-3.5T"
    else if ((m = s.match(/(\d+(?:\.\d+)?)\s*T?\s*[-–]\s*(\d+(?:\.\d+)?)\s*T/i))) {
      out.tonMin = parseFloat(m[1]); out.tonMax = parseFloat(m[2]);
    }
    // "GCV >40T" / "GCV ABOVE 40T"
    else if ((m = s.match(/(?:>|ABOVE|GT)\s*(\d+(?:\.\d+)?)\s*T/i))) out.tonMin = parseFloat(m[1]);
    return out;
  }
  // PCV
  if (/^PCV\b/.test(s)) { out.product = 'PCV'; return out; }
  // Misc
  if (/^MISC?\b/.test(s)) { out.product = 'MISC'; return out; }
  // Pvt Car / Private Car
  if (/^PVT\s*CAR\b|^PRIVATE\s*CAR\b|^4\s*W\b|^CAR\b/.test(s)) { out.product = 'CAR'; return out; }
  // TW sub-categories
  if (/BIKE|MOTOR\s*CYCLE/.test(s)) { out.product = 'TW'; out.category = 'Bike'; return out; }
  if (/SCOOTER|SCOOTY/.test(s))     { out.product = 'TW'; out.category = 'Scooter'; return out; }
  if (/MOPED/.test(s))              { out.product = 'TW'; out.category = 'Moped'; return out; }
  return out;
}

/** Detect a sheet's schema. Returns { headerIdx, cols } or null when the
 *  sheet has no parseable margin data (Notes / commentary / wrong shape).
 *  Tolerates many header naming conventions:
 *    Insurer cols   : "Insurance Name" / "Insurer" / "INSURANCE COMPANY" / "Insurance Company"
 *    Category cols  : "Segment" / "Category" / "Type"
 *    Coverage cols  : "Plan" / "Coverage Type"
 *    Margin styles  : single "Margin" col, OR two cols "Comprehensive"/"Comp" + "SATP"/"TP"
 */
function _detectSheetSchema(rows) {
  const norm = (c) => String(c || '').toLowerCase().trim();
  for (let i = 0; i < Math.min(30, rows.length); i++) {
    const row = (rows[i] || []).map(norm);
    if (row.length === 0) continue;
    // Insurer column present?
    const insurerIdx = row.findIndex(c =>
      c === 'insurance name' || c === 'insurer' ||
      c === 'insurance company' || c === 'insurance company name'
    );
    if (insurerIdx < 0) continue;
    // Find margin column(s). Single "Margin", or two columns by ins_product.
    const findIdx = (...names) => {
      for (const n of names) { const i = row.indexOf(n); if (i >= 0) return i; }
      return -1;
    };
    const marginIdx = findIdx('margin', 'margin %');
    const compIdx   = findIdx('comprehensive', 'comp');
    const tpIdx     = findIdx('satp', 'tp', 'third party');
    const marginCols = [];
    if (marginIdx >= 0) {
      marginCols.push({ idx: marginIdx, insProduct: null, label: 'Margin' });
    } else {
      if (compIdx >= 0) marginCols.push({ idx: compIdx, insProduct: 'Comp', label: 'Comprehensive' });
      if (tpIdx   >= 0) marginCols.push({ idx: tpIdx,   insProduct: 'TP',   label: 'TP/SATP' });
    }
    if (marginCols.length === 0) continue;
    const cols = {
      insurer:  insurerIdx,
      category: findIdx('category', 'segment', 'type', 'vehicle category'),
      coverage: findIdx('coverage type', 'plan'),
      fuel:     findIdx('fuel type', 'fueltype', 'fuel'),
      cc:       findIdx('cubic capacity', 'cc'),
      ncb:      findIdx('with ncb & with out ncb ', 'with ncb & with out ncb', 'ncb'),
      cond:     findIdx('condition', 'remarks', 'remark'),
      rto:      findIdx('rto'),
      state:    findIdx('state'),
      onpay:    findIdx('on pay', 'onpay'),
      product:  findIdx('product'),
      marginCols,
    };
    return { headerIdx: i, cols };
  }
  return null;
}

/** Convert one row → ARRAY of margin records (one per margin column ×
 *  one per coverage-type token). E.g. a row with 2 margin cols (Comp+TP)
 *  emits 2 records; a row with Coverage Type "Comp/Third Party" + single
 *  Margin col emits 2 records. */
function _parseMarginRow(rowVals, idx, schema, ctx) {
  const { cols } = schema;
  const cell = (i) => i >= 0 ? rowVals[i] : '';
  const insurerName = String(cell(cols.insurer) || '').trim();
  if (!insurerName) return [];
  // Some sheets repeat header text ("CV") in row 1 of data — skip when no margin.
  const hasAnyMargin = cols.marginCols.some(mc => String(cell(mc.idx) || '').trim() !== '' && String(cell(mc.idx) || '').trim() !== '-');
  if (!hasAnyMargin) return [];
  const errors = [];

  // Parse the insurer cell — many sheets pack tonnage / seating into it
  // (e.g. "Chola Upto 3.5T", "Bajaj (6+1)").
  const ic = _parseInsurerCell(insurerName);
  if (ic.sectionDivider) return []; // section heading row → skip silently
  const slug = ic.slug;
  if (!slug) errors.push(`unknown insurer "${insurerName}"`);

  // Build the BASE filter set (everything except ins_product, which varies
  // per emission). filename-driven defaults from ctx (e.g. Pvt Car file →
  // searchProduct='CAR') get overridden by category-cell parsing if present.
  const baseFilters = {};
  if (slug) baseFilters.searchInsurer = slug;
  if (ctx.defaultProduct) baseFilters.searchProduct = ctx.defaultProduct;
  if (ctx.defaultInsProduct) baseFilters.searchInsProduct = ctx.defaultInsProduct;
  // Tonnage extracted from the insurer cell (CV 4W layout).
  if (ic.tonMin != null) baseFilters.searchTonMin = ic.tonMin;
  if (ic.tonMax != null) baseFilters.searchTonMax = ic.tonMax;
  // Seating from "(6+1)" / "(7-10)" tokens.
  if (ic.seatingMin != null) baseFilters.searchSeatingMin = ic.seatingMin;
  if (ic.seatingMax != null) baseFilters.searchSeatingMax = ic.seatingMax;

  // Category cell → product / category / tonnage
  const catRaw = cell(cols.category);
  const cat = _parseCategoryCell(catRaw);
  if (cat.product) baseFilters.searchProduct = cat.product;
  if (cat.category) baseFilters.searchVehicleCategory = cat.category;
  if (cat.tonMin != null) baseFilters.searchTonMin = cat.tonMin;
  if (cat.tonMax != null) baseFilters.searchTonMax = cat.tonMax;

  // "Product" column (some GJ sheets have it explicitly: "GCV" / "PCV")
  if (cols.product >= 0 && !baseFilters.searchProduct) {
    const pRaw = String(cell(cols.product) || '').trim().toUpperCase();
    if (pRaw && pRaw !== '-') {
      const pc = _parseCategoryCell(pRaw);
      if (pc.product) baseFilters.searchProduct = pc.product;
    }
  }

  // Make (Condition column)
  const make = _conditionToMake(cell(cols.cond));
  if (make) baseFilters.searchMake = make;

  // Fuel
  const fuelRaw = String(cell(cols.fuel) || '').trim();
  if (fuelRaw && fuelRaw !== '-' && !/^all/i.test(fuelRaw)) {
    if (/electric|^ev$/i.test(fuelRaw))      baseFilters.searchFuelType = 'Electric';
    else if (/diesel/i.test(fuelRaw))        baseFilters.searchFuelType = 'Diesel';
    else if (/petrol/i.test(fuelRaw))        baseFilters.searchFuelType = 'Petrol';
    else if (/cng|lpg/i.test(fuelRaw))       baseFilters.searchFuelType = 'CNG';
  }

  // CC band
  const cc = _parseCcCell(cell(cols.cc));
  if (cc.ccMin != null) baseFilters.searchCcMin = cc.ccMin;
  if (cc.ccMax != null) baseFilters.searchCcMax = cc.ccMax;
  if (cc.fuelOverride && !baseFilters.searchFuelType) baseFilters.searchFuelType = cc.fuelOverride;

  // State + RTO
  let state = _expandState(cell(cols.state));
  const rtoRaw = String(cell(cols.rto) || '').trim();
  if (!state) {
    const stateFromRto = _expandState(rtoRaw);
    if (stateFromRto) state = stateFromRto;
  }
  if (state) baseFilters.searchState = state;
  // Cluster — keep when it's a real city / cluster name (not blank, not
  // wildcard, not pure state abbrev that the State col already covers).
  const _STATE_ABBREVS = new Set([
    'TN','KA','KL','MH','GJ','UP','HR','PB','RJ','MP','CG','UK','HP','JK',
    'WB','BR','JH','OD','OR','DL','GA','AS','AP','TS','TG','CH','CT',
  ]);
  const _isPureStateAbbrev = (v) =>
    v.split(/[,/+&]/).map(s => s.trim().toUpperCase()).every(s => _STATE_ABBREVS.has(s));
  if (rtoRaw && rtoRaw !== '-'
      && !/^all\b/i.test(rtoRaw)
      && !/^(north|south|east|west|central|northeast)(\s+(rto|india|zone))?$/i.test(rtoRaw)
      && !_isPureStateAbbrev(rtoRaw)) {
    baseFilters.searchCluster = rtoRaw;
  }

  // Description shared across emissions
  const onpay = String(cell(cols.onpay) || '').trim();
  const cond  = String(cell(cols.cond) || '').trim();
  const ccRaw = String(cell(cols.cc) || '').trim();
  const descBase = [
    `[${ctx.fileName} :: ${ctx.sheetName} :: row ${idx + 1}]`,
    insurerName,
    String(catRaw || ''),
    String(cell(cols.coverage) || ''),
    ccRaw !== '-' && ccRaw ? `CC:${ccRaw}` : '',
    cond  !== '-' && cond  ? `Cond:${cond}` : '',
    rtoRaw !== '-' && rtoRaw ? `RTO:${rtoRaw}` : '',
    String(cell(cols.state) || ''),
    onpay ? `On:${onpay}` : '',
  ].map(s => String(s || '').trim()).filter(Boolean).join(' | ');

  // Determine the (margin %, ins_product) pairs to emit. Two cases:
  //  A) Two-margin-col schema (e.g. GJ "Comprehensive" + "SATP") — emit one
  //     record per non-blank margin cell, ins_product comes from the column.
  //  B) Single-margin-col schema — split the Coverage Type cell into ins
  //     products, emit one record per token.
  const records = [];
  // Extract a leading numeric percentage from a cell. Handles plain "5",
  // "5%", "4.50% OD +_ 5 TP", "4.5 % on OD" — everything after the first
  // number is treated as commentary that we keep in the description below.
  const _parseMarginValue = (v) => {
    const s = String(v || '').trim().replace(/^%?/, '');
    if (!s) return NaN;
    const m = s.match(/^\s*([\d.]+)/);
    if (!m) return NaN;
    const n = parseFloat(m[1]);
    return isFinite(n) ? n : NaN;
  };
  if (cols.marginCols.length > 1) {
    // Schema A
    for (const mc of cols.marginCols) {
      const v = String(cell(mc.idx) || '').trim();
      if (!v || v === '-') continue;
      const num = _parseMarginValue(v);
      if (isNaN(num)) { errors.push(`invalid ${mc.label} "${v}"`); continue; }
      records.push({ ins_product: mc.insProduct, margin_pct: num });
    }
  } else {
    // Schema B
    const v = String(cell(cols.marginCols[0].idx) || '').trim();
    if (!v || v === '-') return [];
    const num = _parseMarginValue(v);
    if (isNaN(num)) { errors.push(`invalid margin "${v}"`); return _wrapErr(idx, descBase, errors); }
    const ipsFromCoverage = _coverageTypeToInsProducts(cell(cols.coverage));
    const ips = ipsFromCoverage.length > 0 ? ipsFromCoverage : [null];
    for (const ip of ips) records.push({ ins_product: ip, margin_pct: num });
  }

  // Materialise final records
  const out = [];
  for (const rec of records) {
    const f = { ...baseFilters };
    if (rec.ins_product) f.searchInsProduct = rec.ins_product;
    out.push({
      rowIndex: idx + 1,
      description: descBase + (rec.ins_product ? ` | ${rec.ins_product}` : ''),
      filters: f,
      margin_pct: rec.margin_pct,
      errors: errors.slice(),
    });
  }
  if (out.length === 0 && errors.length > 0) return _wrapErr(idx, descBase, errors);
  return out;
}

function _wrapErr(idx, desc, errors) {
  return [{ rowIndex: idx + 1, description: desc, filters: {}, margin_pct: NaN, errors }];
}

/** Hint a sheet's default product / ins_product from the source filename
 *  + sheet name. Useful for files whose rows lack an explicit category col
 *  (Pvt Car Comp SAOD has no Category column — implicit Pvt Car). */
function _hintFromName(fileName, sheetName) {
  const blob = (String(fileName || '') + ' ' + String(sheetName || '')).toLowerCase();
  const out = { defaultProduct: null, defaultInsProduct: null };
  if (/pvt\.?\s*car|private\s*car|\bcar\b/.test(blob)) out.defaultProduct = 'CAR';
  else if (/\b3w\s*cv\b|3\s*wheeler/.test(blob)) out.defaultProduct = 'GCV'; // 3W CV sheets default to GCV
  else if (/\b4w\s*cv\b/.test(blob))  out.defaultProduct = 'GCV';
  else if (/\bcv\b|commercial/.test(blob)) out.defaultProduct = 'GCV';
  else if (/\btw\b|two\s*wheeler|two-wheeler/.test(blob)) out.defaultProduct = 'TW';
  else if (/\bpcv\b/.test(blob)) out.defaultProduct = 'PCV';
  if (/third\s*party|\btp\b|satp/.test(blob)) out.defaultInsProduct = 'TP';
  else if (/saod/.test(blob) && !/comp/.test(blob)) out.defaultInsProduct = 'SAOD';
  return out;
}

/** POST /upload — multipart upload of one or more margin sheets.
 *  Accepts either:
 *    - field "files" with one or many .xlsx/.xls files (preferred)
 *    - field "file"  with a single .xlsx/.xls file (back-compat)
 *  Loops every sheet in every workbook, auto-detects header row + columns
 *  per-sheet, and emits one or more margin records per data row (multi-
 *  margin-column sheets emit per-coverage records).
 *  Returns { files:[ {name, sheets:[{name, ...counts, errors[]}]} ], totals } */
router.post('/upload', marginUpload.any(), async (req, res, next) => {
  try {
    const uploaded = (req.files && req.files.length > 0)
      ? req.files
      : (req.file ? [req.file] : []);
    if (uploaded.length === 0) {
      return res.status(400).json({ success: false, error: 'No file uploaded (field "files" or "file")' });
    }

    const pool = await getPool();
    const fileResults = [];
    let totCreated = 0, totUpdated = 0, totSkipped = 0, totErrors = 0;

    // Single MERGE per record — saves the round-trip a SELECT+INSERT/UPDATE
    // would cost, and OUTPUT $action tells us whether we created vs updated.
    const upsertOne = async (m) => {
      const sig = signatureOf(m.filters);
      const r = await pool.request()
        .input('sig',     sql.NVarChar(500), sig)
        .input('desc',    sql.NVarChar(500), String(m.description || '').slice(0, 500))
        .input('filters', sql.NVarChar(sql.MAX), JSON.stringify(m.filters))
        .input('pct',     sql.Decimal(6, 3), m.margin_pct)
        .query(`
          MERGE margin_rules WITH (HOLDLOCK) AS tgt
          USING (SELECT @sig AS sig) AS src
            ON tgt.filter_signature = src.sig AND tgt.active = 1
          WHEN MATCHED THEN UPDATE SET
            description = @desc, filters_json = @filters,
            margin_pct = @pct, updated_at = GETDATE()
          WHEN NOT MATCHED THEN INSERT
            (description, filters_json, filter_signature, margin_pct)
            VALUES (@desc, @filters, @sig, @pct)
          OUTPUT $action AS action;`);
      return r.recordset[0]?.action; // 'INSERT' | 'UPDATE'
    };

    // Run async tasks with bounded concurrency. Stops on first throw to
    // surface DB errors; sheet-level error bookkeeping happens inline.
    const runConcurrent = async (items, limit, fn) => {
      const out = new Array(items.length);
      let cursor = 0;
      const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (true) {
          const i = cursor++;
          if (i >= items.length) return;
          out[i] = await fn(items[i], i);
        }
      });
      await Promise.all(workers);
      return out;
    };

    for (const f of uploaded) {
      const fileName = f.originalname;
      const fileResult = { name: fileName, sheets: [], error: null };
      let wb;
      try {
        wb = XLSX.readFile(f.path);
      } catch (e) {
        fileResult.error = `failed to read workbook: ${e.message}`;
        fileResults.push(fileResult);
        continue;
      }

      for (const sheetName of wb.SheetNames) {
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '', raw: false });
        const schema = _detectSheetSchema(rows);
        const sheetResult = { name: sheetName, parsed: 0, created: 0, updated: 0, skipped: 0, errors: [] };

        if (!schema) {
          sheetResult.skipped_reason = 'no recognised header row';
          fileResult.sheets.push(sheetResult);
          continue;
        }

        const hint = _hintFromName(fileName, sheetName);
        const ctx = { fileName, sheetName, ...hint };

        const dataRows = rows.slice(schema.headerIdx + 1)
          .filter(r => r && r.some(c => String(c).trim() !== ''));

        // Fan out: each input row → 0..N margin records.
        const records = [];
        for (let i = 0; i < dataRows.length; i++) {
          const r = dataRows[i];
          const recs = _parseMarginRow(r, schema.headerIdx + 1 + i, schema, ctx);
          for (const rec of recs) records.push(rec);
        }
        sheetResult.parsed = records.length;

        // Filter to writable records, capturing errors. Then dedup by signature
        // (last record for the same sig wins — typical "later row overrides").
        const bySig = new Map();
        for (const m of records) {
          if (m.errors && m.errors.length > 0) {
            sheetResult.errors.push({ row: m.rowIndex, reason: m.errors.join('; ') });
            sheetResult.skipped++;
            continue;
          }
          if (!Number.isFinite(m.margin_pct)) {
            sheetResult.errors.push({ row: m.rowIndex, reason: 'invalid margin %' });
            sheetResult.skipped++;
            continue;
          }
          const sig = signatureOf(m.filters);
          if (!sig) {
            sheetResult.errors.push({ row: m.rowIndex, reason: 'no usable filters' });
            sheetResult.skipped++;
            continue;
          }
          bySig.set(sig, m); // last wins
        }
        const writable = [...bySig.values()];

        // Concurrency 16 — high enough to mask DB latency, low enough to
        // stay polite to the connection pool.
        try {
          const actions = await runConcurrent(writable, 16, upsertOne);
          for (const a of actions) {
            if (a === 'INSERT') sheetResult.created++;
            else if (a === 'UPDATE') sheetResult.updated++;
          }
        } catch (err) {
          sheetResult.errors.push({ row: 0, reason: 'DB error: ' + (err.message || String(err)) });
        }

        totCreated += sheetResult.created;
        totUpdated += sheetResult.updated;
        totSkipped += sheetResult.skipped;
        totErrors  += sheetResult.errors.length;
        // Cap per-sheet error array so the response stays manageable.
        sheetResult.error_count = sheetResult.errors.length;
        sheetResult.errors = sheetResult.errors.slice(0, 25);
        fileResult.sheets.push(sheetResult);
      }
      fileResults.push(fileResult);
    }

    res.json({
      success: true,
      files: fileResults,
      totals: {
        files: uploaded.length,
        created: totCreated,
        updated: totUpdated,
        skipped: totSkipped,
        error_count: totErrors,
      },
    });
  } catch (err) { next(err); }
});

module.exports = router;
// Expose the rate-rule coverage helpers so other services (e.g. excel-export)
// can compute "which margin covers this rule" without duplicating the logic.
module.exports.marginCoversRateRule = marginCoversRateRule;
module.exports.canonInsurer        = canonInsurer;
module.exports.normVtype           = normVtype;
