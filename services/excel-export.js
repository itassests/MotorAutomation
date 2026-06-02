/**
 * Excel export service.
 *
 * Transforms parsed rate_rules + rto_mappings rows from the database into
 * a downloadable .xlsx workbook matching the user's 28-column "master" sheet
 * format. One rule = one row. Multi-value cells (RTO codes) are emitted as
 * comma-separated strings.
 *
 * Gap columns (IDV, City, State, Discount, HEV) are intentionally left blank
 * — the extractors do not capture these today.
 */

const XLSX = require('xlsx');
const sql = require('mssql');
const { getPool } = require('../db/connection');
const { parseRtoCodes, parseCCBand, parseSeatingCapacity } = require('../parsers/utils/normalizer');
// Pulled lazily from routes/margins.js to avoid a circular import at load
// time (margins.js requires this module's parent indirectly via the router
// chain). require() is cheap once cached.
function _marginsModule() { return require('../routes/margins'); }
// Set by buildExportBufferFromData() at the start of an export run so
// ruleToRow() can look up "which margin covers this rate-rule?" without
// being passed the list explicitly.
let _activeMarginsForExport = [];
// LLM extracts keyed by the verbatim remark text. Populated by
// buildExportBuffer from parsed_remarks_cache so the inference helpers
// (NCB, IDV, CPA, business type, zone) can prefer LLM-derived values
// over regex when the regex misses ("with out" / "with-out" variants).
let _llmExtractByRemark = new Map();

function _llmGet(remark) {
  if (!remark || _llmExtractByRemark.size === 0) return null;
  return _llmExtractByRemark.get(String(remark)) || null;
}
function _findMarginForRule(rule) {
  if (!_activeMarginsForExport || _activeMarginsForExport.length === 0) return null;
  let covers;
  try { covers = _marginsModule().marginCoversRateRule; } catch { return null; }
  if (typeof covers !== 'function') return null;
  // Most-specific (most filter keys) first so a narrowly-scoped rule wins
  // over a broad one when both apply.
  const sorted = _activeMarginsForExport.slice().sort((a, b) =>
    Object.keys(b.filters || {}).length - Object.keys(a.filters || {}).length
  );
  for (const m of sorted) {
    if (covers(m.filters || {}, rule)) return m;
  }
  return null;
}

// 37-column header — exact spelling matches the user's master template
const HEADERS = [
  'Srno',
  'Insurer',
  'StartDate',
  'EndDate',
  'VehicleType',
  'VehicleCategory',
  'ProductType',
  'Make',
  'Modal',
  'Sub Modal',
  'Owned By',
  'FuelType',
  'MinimumCC',
  'MaximumCC',
  'MinimumSeatingCapacity',
  'MaximumSeatingCapacity',
  'MinAgeofvehicle',
  'MaxAgeOfVehicle',
  'Min NOP',
  'Max NOP',
  'Minimumtonnage',
  'Maximumtonnage',
  'MinIDV',
  'MaxIDV',
  'RTOCode',
  'city',
  'State',
  'Zone',
  'Addon',
  'Nil Dep',
  'CPA',
  'BusinessType',
  'Break-In',
  'OD_Tenure',
  'TP_Tenure',
  'min discount',
  'Discount',
  'MinimumNCB',
  'MaximumNCB',
  'MinimumVolume',
  'MaximunVolume',
  'Highend',
  'Netpoint',
  'OD Rate',
  'TP Rate',
  'Margin',         // % from the saved margin rule covering this row (blank = none)
  'Outgoing Rate',  // = Netpoint − Margin (or OD/TP rate − Margin when Netpoint blank)
  'Applied on',
  'SheetName',
  'Remarks',        // verbatim UW remarks — surfaces excluded RTOs / sub-types / models / etc.
];

// ---------- Normalizers ----------

// Map our internal insurer slug to the Prarambh ShortName that
// App_UPloadPointsdetails uses to look up the insurer. Must match the
// ShortName column in vw_NewTempPrarambhExcelMotorDownload / InsurerMaster
// exactly, or the SP silently drops rows.
const INSURER_DISPLAY = {
  digit: 'Digit',
  go_digit: 'Digit',
  godigit: 'Digit',
  bajaj_allianz: 'Bajaj Allianz',
  bajaj: 'Bajaj Allianz',
  chola: 'Cholamandalam',
  chola_ms: 'Cholamandalam',
  cholamandalam: 'Cholamandalam',
  hdfc_ergo: 'HDFC ERGO',
  icici_lombard: 'ICICI Lombard',
  tata_aig: 'TATA AIG',
  reliance: 'Reliance',
  iffco_tokio: 'IFFCO Tokio',
  future_generali: 'Future Generali',
  sbi_general: 'SBI General',
  new_india: 'New India',
  national: 'National',
  oriental: 'Oriental',
  united_india: 'United India',
  royal_sundaram: 'Royal Sundaram',
  acko: 'Acko',
  navi: 'Navi',
  zuno: 'Zuno',
  kotak: 'Kotak',
  liberty: 'Liberty',
  magma: 'Magma',
  shriram: 'Shriram',
  raheja_qbe: 'Raheja QBE',
  bharti_axa: 'Bharti AXA',
  dhfl_pramerica: 'DHFL Pramerica',
};

function normalizeInsurer(slug) {
  if (!slug) return '';
  const key = String(slug).toLowerCase().trim();
  return INSURER_DISPLAY[key] || slug;
}

/**
 * Resolve StartDate / EndDate for an exported row.
 *
 * StartDate priority:  rule._effective_from → rule._uploaded_at → today
 * EndDate:             StartDate + 365 days
 *
 * The stored procedure App_UPloadPointsdetails rejects rows with missing
 * dates ("Please enter start and end dates"), so we always emit both as
 * YYYY-MM-DD strings.
 */
function formatDateYmd(d) {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return null;
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const day = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
/** Return "DD-MMM-YY" (e.g. "01-Mar-26") — Prarambh's own date convention. */
function formatDateDdMmmYy(d) {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return null;
  const day = String(dt.getUTCDate()).padStart(2, '0');
  const mon = MONTH_ABBR[dt.getUTCMonth()];
  const yy  = String(dt.getUTCFullYear()).slice(-2);
  return `${day}-${mon}-${yy}`;
}
function rateCardDates(rule) {
  const baseYmd =
    formatDateYmd(rule._effective_from) ||
    formatDateYmd(rule._uploaded_at) ||
    formatDateYmd(new Date());
  const startDt = new Date(baseYmd + 'T00:00:00Z');
  // Prefer the explicit effective_to set when a newer card supersedes
  // this one (monthly cycle close-out).  Falls back to start + 365d
  // when the card is still open-ended.
  let endDt;
  const explicitEnd = formatDateYmd(rule._effective_to);
  if (explicitEnd) {
    endDt = new Date(explicitEnd + 'T00:00:00Z');
  } else {
    endDt = new Date(startDt.getTime() + 365 * 86400 * 1000);
  }
  return {
    start: formatDateDdMmmYy(startDt),
    end:   formatDateDdMmmYy(endDt),
  };
}

/**
 * Infer Vehicle Type (Pvt car / TW / GCV / PCV / MIS) from segment, sheet name + product hint.
 * Segment-level overrides take priority (e.g. E-Rickshaw → PCV, Backhoe → MISC).
 */
function inferVehicleType(sheetName, product, segment, subType) {
  const seg = (String(segment || '') + ' ' + String(subType || '')).toLowerCase();

  // Segment-level overrides
  if (/e-rickshaw|e-auto/i.test(seg)) return 'PCV';
  if (/backhoe|forklift|excavator.*loader/i.test(seg)) return 'MIS';
  if (/^jcb/i.test(seg)) return 'MIS';
  // Chola shorthand: "GCCV" → GCV, "PCCV" / "PCCV<6" / "PCCV>6" → PCV, "MSV" → MIS
  if (/\bGCCV\b|(?:^|_)GCCV(?:_|\b)/i.test(seg)) return 'GCV';
  if (/\bPCCV\b|(?:^|_)PCCV[<>=]/i.test(seg)) return 'PCV';
  if (/\bMSV\b/i.test(seg)) return 'MIS';
  // Tractor segments (with or without [NEW]/[RENEWAL])
  if (/tractor|(?:^|_)trac(?:\[|\b)/i.test(seg)) return 'MIS';
  if (/e-loader/i.test(seg)) return 'MIS';
  if (/excavator|harvest[oe]r/i.test(seg)) return 'MIS';   // accept harvester / harvestor
  if (/^misc/i.test(seg)) return 'MIS';
  // TATA-style standalone CV segments classified by the user as MIS:
  //   "Trailer", "Trade Road Risk", "Crane", "Bulker"
  if (/^\s*trailer\s*$/i.test(seg))      return 'MIS';
  if (/trade\s*road\s*risk/i.test(seg))  return 'MIS';
  if (/^\s*crane\s*$/i.test(seg))        return 'MIS';
  if (/^\s*bulker\s*$/i.test(seg))       return 'MIS';

  // Tonnage / weight-band markers in the segment indicate a goods carrier
  // (GCV). Royal state CV grids use bare numeric ranges like "0 to 2.3",
  // "20 to 40", "Above 45" without any "GCV" prefix.  CC ranges (e.g.
  // "1000 - 1500 CC" in Royal New Car) MUST NOT match, so:
  //   - if "CC" appears anywhere in the segment, skip the tonnage rules
  //   - tonnage upper bound must be < 100 (tonnage is 0-99 T; CC is in
  //     hundreds / thousands)
  if (!/\bCC\b/i.test(seg)) {
    const tonRange = seg.match(/^\s*([\d.]+)\s*(?:to|-|–|and)\s*([\d.]+)\b/i);
    if (tonRange && parseFloat(tonRange[2]) < 100) return 'GCV';
    const tonAbove = seg.match(/^\s*Above\s+([\d.]+)\b/i);
    if (tonAbove && parseFloat(tonAbove[1]) < 100) return 'GCV';
  }
  if (/\bGCV\b/i.test(seg) || /\b\d+(\.\d+)?\s*T\b/i.test(seg))      return 'GCV';

  const s = String(sheetName || '').toLowerCase();
  const p = String(product || '').toLowerCase();

  // Product-level overrides (from classifier)
  if (p === 'pcv') return 'PCV';
  if (p === 'misc') return 'MIS';
  if (p === 'gcv') return 'GCV';

  // CV-class sheets first — "4W GCV EV" / "3W GCV Comp" sheet names contain
  // "4w"/"3w" but the GCV/CV token pins them as goods carriers, NOT private
  // car. Resolve those before the Pvt-car heuristic.
  if (/\b(hcv|gcv|goods|truck|tipper)\b/.test(s)) return 'GCV';
  if (/\bcv\b/.test(s)) return 'GCV'; // generic CV defaults to GCV

  // 2-wheeler
  if (/\b(2w|tw|2 ?wheeler|2 ?wheler|two ?wheeler)\b/.test(s)) return 'TW';
  if (p === '2w' || p === 'tw') return 'TW';

  // Private car
  if (/\b(pvt ?car|private ?car|pvtcar|4w)\b/.test(s)) return 'Pvt car';
  if (p === '4w' || p === 'pvt car' || p === 'pvtcar' || p === 'car') return 'Pvt car';
  // Chola-style "PC" / "PC [SOD]" in segment indicates Private Car
  if (/^PC\b|\bPC\s*\[/i.test(seg)) return 'Pvt car';

  // Passenger CV — taxi, bus, school, staff, passenger carrier
  if (/\b(taxi|bus|school|staff|passenger|pcv)\b/.test(s)) return 'PCV';

  // Misc
  if (/\b(non ?motor|misc|miscellaneous)\b/.test(s)) return 'MIS';

  return 'MIS';
}

/**
 * Infer Vehicle Category from segment text.
 * Extracts specific sub-type like E-Rickshaw, Backhoe loader, Tractor, JCB, etc.
 *
 * Examples:
 *   "E-Rickshaw Age 0-1"                              → "E-Rickshaw"
 *   "E-Auto"                                          → "E-Auto"
 *   "E-Loaders"                                       → "E-Loaders"
 *   "Backhoe loader, Forklift, Excavator, and loader"  → "Backhoe loader, Forklift, Excavator, and loader"
 *   "Backhoe loader, Forklift, Excavator, and loader age 1+" → "Backhoe loader, Forklift, Excavator, and loader"
 *   "GCV4 upto 1.6T 0-5 years"                       → "GCV4"
 *   "GCV3"                                            → "GCV3"
 *   "Tractor 0-5 years"                               → "Tractor"
 *   "JCB age 6+"                                      → "JCB"
 *   "Taxi upto 5 seater"                              → "Taxi"
 */
function inferVehicleCategory(segment, rateType, sheetName) {
  const s = String(segment || '').trim();
  const rt = String(rateType || '').toUpperCase();
  const sn = String(sheetName || '');

  // Misc-D / Tractor family — segments shaped "<base> | <vehicle-class>"
  // return the class verbatim.  Used by Universal Sompo and Reliance to
  // lift the specific sub-class (Crane/Excavator, Bacho loader, JCB/L&T/
  // Caterpillar, Agricultural without Trailer, …) into VehicleCategory
  // instead of Sub Modal.  Match before the generic Excavator / Crane /
  // Tractor patterns below so the full label wins.
  const subClassMatch = s.match(/^(?:Misc-?D|Tractor)\s*\|\s*(.+)$/i);
  if (subClassMatch) return subClassMatch[1].trim();

  // Section-marker in segment: "School Bus | Gujarat" or just "Staff Bus"
  if (/^Staff\s*Bus(\s*\||$)/i.test(s)) return 'Staff Bus';
  if (/^School\s*Bus(\s*\||$)/i.test(s)) return 'School Bus';

  // Bajaj CV PCV body-types embedded mid-segment:
  //   "PCV 4W Staff Bus nd SC >10"              → Staff Bus
  //   "PCV 4W other than school bus and SC <10" → Non-School Bus
  if (/other\s+than\s+school\s+bus/i.test(s)) return 'Non-School Bus';
  if (/\bStaff\s+Bus\b/i.test(s)) return 'Staff Bus';
  if (/\bSchool\s+Bus\b/i.test(s)) return 'School Bus';

  // Auto (3-wheeler taxi) — Future Generali / various CV grids.  Classifies
  // under PCV product with VehicleCategory='Auto'.
  if (/^Auto$/i.test(s)) return 'Auto';
  if (/^BOLERO$/i.test(s)) return 'BOLERO';

  // United India "Two Wheeled PCV" / "Three Wheeled PCV" / "Four Wheeled PCV":
  // VehicleType is PCV (handled by product), but Category should call out the
  // wheel-count carrier subtype.
  if (/^2W\s+PCV$/i.test(s)) return 'TW';
  if (/^3W\s+PCV$/i.test(s)) return '3W';
  if (/^4W\s+PCV(\s|$)/i.test(s)) return '4W';
  // Taxi, Educational/Staff Bus
  if (/^Taxi$/i.test(s)) return 'Taxi';
  if (/^Educational\/Staff\s+Bus$/i.test(s) || /Educational.*Staff.*Bus/i.test(s)) return 'Staff Bus';
  // UII Misc "Bands / Vehicle Type" rows — surface segment as VC verbatim
  if (/^Ambulance(s)?$/i.test(s)) return 'Ambulance';
  if (/^Agricultural\s+Tractor/i.test(s)) return 'Agricultural Tractor';
  if (/^All\s+other\s+Misc/i.test(s)) return 'MISC-D';
  if (/^Road\s+Risk,?\s*Transit/i.test(s)) return 'Road Risk, Transit & Internal Risk';
  if (/^Standalone\s+CPA$/i.test(s)) return 'Standalone CPA';
  // UII GCV E-Cart — distinct GVW-bucketed electric goods carrier, shown
  // as its own VehicleCategory rather than the generic "GCV".
  if (/^E-?Cart$/i.test(s)) return 'E-Cart';
  // Magma 2W split — segment is tagged "TW Bike" / "TW Scooter" so the
  // VehicleCategory column can distinguish bikes from scooters even though
  // both share product='TW'.
  if (/^TW\s+Bike$/i.test(s))    return 'Bike';
  if (/^TW\s+Scooter$/i.test(s)) return 'Scooter';
  // Magma Misc-D variants (Others / Garbage) — segment 'MISC-D' alone.
  if (/^MISC-?D$/i.test(s)) return 'MISC-D';
  // IFFCO bus seat-band segments → VehicleCategory = "Bus"
  if (/^Bus\s*\(/i.test(s)) return 'Bus';
  // IFFCO Misc-D sub-types → surface verbatim in VehicleCategory
  if (/^Ambulance$/i.test(s))      return 'Ambulance';
  if (/^Excavator/i.test(s))       return 'Excavator';
  if (/^Mobile\s+Crane/i.test(s))  return 'Mobile Crane';
  if (/^Publicity\s+Van/i.test(s)) return 'Publicity Van';
  if (/^Transit\s+Mixer/i.test(s)) return 'Transit Mixer';
  if (/^E-?Rickshaw$/i.test(s))    return 'E-Rickshaw';
  // Kotak MISD Garbage Van / Cash Van carve-outs
  if (/^Garbage\s+Van$/i.test(s))  return 'Garbage Van';
  if (/^Cash\s+Van$/i.test(s))     return 'Cash Van';
  // Raheja PCV Auto Rickshaw / Kali Peeli (split into two distinct categories).
  if (/^Auto\s+Ric?ks?h?aw$/i.test(s)) return 'Auto Rickshaw';
  if (/^Kali\s+Peeli$/i.test(s))       return 'Kali Peeli';
  // Legacy combined label (in case any older rule still uses it)
  if (/Auto\s*Ric?ks?h?aw.*Kali\s*Peeli|Kali\s*Peeli.*Auto/i.test(s)) return 'Auto Rickshaw / Kali Peeli';
  if (/^Agri\s+Tractor$/i.test(s)) return 'Agri Tractor';
  // Raheja GCV weight bands & Flat Bed
  if (/^GCV\s+Flat\s*Bed$/i.test(s)) return 'GCV Flat Bed';
  if (/^GCV\s+≤?2\.5T$/i.test(s) || /^GCV\s+<=?\s*2\.5T$/i.test(s)) return 'GCV ≤2.5T';
  if (/^GCV\s+2\.5-3\.5T$/i.test(s)) return 'GCV 2.5-3.5T';
  if (/^GCV\s+3\.5-7\.5T$/i.test(s)) return 'GCV 3.5-7.5T';

  // Sheet-name-based detection for PCV categories
  if (/School.*Bus/i.test(sn) || /Staff.*Bus/i.test(sn)) {
    if (/STAFF/i.test(rt)) return 'Staff Bus';
    // Default to School Bus for School & Staff Bus sheet (School Bus is first section)
    return 'School Bus';
  }

  if (!s) return '';

  // E-Rickshaw — match anywhere in segment so prefixed forms like
  // "3W E-Rickshaw Pan India ..." resolve correctly. Royal labels these
  // as "3 Wheeler E-Rickshaw" in the source sheet header — preserve that.
  if (/E-Rickshaw/i.test(s)) return '3 Wheeler E-Rickshaw';

  // E-Auto
  if (/^E-Auto/i.test(s)) return 'E-Auto';

  // E-Loaders
  if (/^E-Loader/i.test(s)) return 'E-Loaders';

  // Backhoe loader, Forklift, Excavator, and loader
  if (/^Backhoe/i.test(s)) return 'Backhoe loader, Forklift, Excavator, and loader';

  // Excavator (standalone, e.g. "2_EXCAVATOR")
  if (/EXCAVATOR/i.test(s)) return 'Excavator';

  // Harvester (matches both "Harvester" and "Harvestor" spellings)
  if (/HARVEST[OE]R/i.test(s)) return 'Harvester';

  // Tractor / Tractors
  if (/Tractor/i.test(s) || /^TRAC/i.test(s)) return 'Tractor';

  // Trade Road Risk (TATA-specific MIS segment)
  if (/Trade\s*Road\s*Risk/i.test(s)) return 'Trade Road Risk';

  // JCB
  if (/^JCB/i.test(s)) return 'JCB';

  // Misc D
  if (/^Misc/i.test(s)) return 'Misc D';

  // --- Body type / vehicle sub-categories (from segment text or rate_type) ---
  // Non-Dumper/Tipper (check before Dumper/Tipper)
  if (/Non[\s-]*Dumper/i.test(s) || /Non[\s-]*Tipper/i.test(s)) return 'Non-Dumper/Tipper';

  // Dumper/Tipper — from segment or rate_type containing DUMPER
  if (/Dumper/i.test(s) || /Tipper/i.test(s) || rt.includes('DUMPER')) return 'Dumper/Tipper';

  // Reefer / Refrigerated (before Container)
  if (/Reefer|Refrigerat/i.test(s) || rt.includes('REEFER')) return 'Reefer';

  // Flat Bed (before Trailer)
  if (/Flat\s*Bed/i.test(s) || rt.includes('FLAT_BED')) return 'Flat Bed';

  // Port Trailer (before generic Trailer)
  if (/Port\s*Trailer/i.test(s) || rt.includes('PORT_TRAILER')) return 'Port Trailer';

  // Trailer (generic)
  if (/Trailer/i.test(s) || rt.includes('TRAILER')) return 'Trailer';

  // Oil Tanker (before generic Tanker)
  if (/Oil\s*Tanker/i.test(s) || rt.includes('OIL_TANKER')) return 'Oil Tanker';

  // Gas Tanker (before generic Tanker)
  if (/Gas\s*Tanker/i.test(s) || rt.includes('GAS_TANKER')) return 'Gas Tanker';

  // Tanker (generic)
  if (/Tanker/i.test(s)) return 'Tanker';

  // Bulker
  if (/Bulker/i.test(s) || rt.includes('BULKER')) return 'Bulker';

  // Carrier (Car Carrier, Container Carrier, etc.)
  const carrierMatch = s.match(/((?:\w+\s+)?Carrier)/i);
  if (carrierMatch) return carrierMatch[1];

  // Crane
  if (/Crane/i.test(s)) return 'Crane';

  // Container
  if (/Container/i.test(s)) return 'Container';

  // Chassis
  if (/Chassis/i.test(s)) return 'Chassis';

  // TW segments: MC / Motor Cycle → Bike, SC/SCOOTER → Scooter, Moped → Moped
  if (/^Motor\s*Cycle\b/i.test(s)) return 'Bike';
  if (/\bMoped\b/i.test(s))         return 'Moped';
  if (/^MC\b|^MC[_><=\s]/i.test(s)) return 'Bike';
  if (/^SC(?:\b|[_\/])|^SCOOTER/i.test(s)) return 'Scooter';
  // KW-based TW-Electric segments (e.g. "7 KW Bike", "7 KW SCOOTER")
  if (/\bSCOOTER\b/i.test(s)) return 'Scooter';
  if (/\bBIKE\b/i.test(s)) return 'Bike';
  // RE (Royal Enfield) → Bike
  if (/^RE$/i.test(s)) return 'Bike';
  // EV standalone for TW → leave empty (could be bike or scooter)

  // GCV / PCV with explicit wheel-class subtypes (TATA-style segments).
  // These must come BEFORE the generic "^GCV\d?" / "^PCV\w*" matchers,
  // because "PCV Bus School 31 to 50" otherwise collapses to just "PCV".
  if (/^PCV\s+Bus\s+School\b/i.test(s))         return 'School Bus';
  if (/^PCV\s+Bus\s+Non\s*School\b/i.test(s))   return 'Non-School Bus';
  if (/^PCV\s+Bus\s+Staff\b/i.test(s))          return 'Staff Bus';
  if (/^PCV\s+Bus\b/i.test(s))                  return 'Bus';
  if (/^PCV\s+4W\s+School\b/i.test(s))          return 'School Cab';
  if (/^PCV\s+4W\s+Non\s*School\b/i.test(s))    return 'Non-School Cab';
  // "GCV 3W" / "PCV 3W" / "PCV 3WDiesel" / "PCV 4W"
  const wheelM = s.match(/^(GCV|PCV)\s*(\d+W)/i);
  if (wheelM) return (wheelM[1] + ' ' + wheelM[2]).toUpperCase();

  // Shriram-style "GCCV 3W Except E-CART" / "PCCV 3W ..." — surface just
  // the wheel-class so the Vehicle Category reads "3W". Skip when the
  // segment names a more-specific sub-class (School/Staff Bus, Tourist
  // Bus, Bolero) — those are matched by the more-specific patterns later.
  const gccvWheelM = s.match(/^(?:GCCV|PCCV)\s*(\d+W)\b/i);
  if (gccvWheelM && !/School|Staff|Tourist|Bus\b/i.test(s)) {
    return gccvWheelM[1].toUpperCase();
  }

  // GCV3, GCV4 etc. — extract just the GCV prefix
  const gcvMatch = s.match(/^(GCV\d?)/i);
  if (gcvMatch) return gcvMatch[1].toUpperCase();

  // GCCV
  if (/^GCCV/i.test(s)) return 'GCCV';

  // HCV
  if (/^HCV/i.test(s)) return 'HCV';

  // Taxi — match anywhere in segment so "PCV Taxi <6 St", "PCV Taxi 7+1",
  // "PCV Taxi Kaali Peeli", "PCV Taxi Short Term" etc. resolve to "Taxi"
  // rather than the generic "PCV" bucket.  Must precede the PCV prefix
  // matcher below.
  if (/\bTaxi\b/i.test(s)) return 'Taxi';

  // PCV3W, PCV
  const pcvMatch = s.match(/^(PCV\w*)/i);
  if (pcvMatch) return pcvMatch[1].toUpperCase();

  // School Bus, Staff Bus, Corporate Bus, Tourist Bus, then generic Bus.
  // Order matters — more-specific names must beat the generic /Bus/ catchall.
  if (/School.*Bus/i.test(s))    return 'School Bus';
  if (/Staff.*Bus/i.test(s))     return 'Staff Bus';
  if (/Corporate.*Bus/i.test(s)) return 'Corporate Bus';
  if (/Tourist.*Bus/i.test(s))   return 'Tourist Bus';
  if (/Bus/i.test(s))            return 'Bus';

  // Chola underscore-shorthand categories: "1_GCCV_3W", "1_3W_AUTO", "2_4W_LT_1500CC",
  //   "3_4W_GT_1500CC", "3_BIG_TAXIS", "4_MAXI_CAB", "5_BUS", "1_TRAC[NEW]"
  //   The leading "N_" is a sort prefix.
  const up = s.toUpperCase();
  // Tractor (with [NEW] / [RENEWAL] optional suffix)
  if (/(?:^|_)TRAC(?:\[|\b)/i.test(up)) return 'Tractor';
  // 3W (3-wheeler): "GCCV_3W", "3W_AUTO"
  if (/(?:^|_)(?:GCCV_)?3W(?:[\s_\[]|$)/i.test(up)) return '3W';
  // 4W (4-wheeler): "4W_LT_1500CC", "4W_GT_1500CC"
  if (/(?:^|_)4W(?:[\s_\[]|$)/i.test(up)) return '4W';
  // BIG TAXIS
  if (/(?:^|_)BIG[_\s]*TAXIS?(?:[\s_\[]|$)/i.test(up)) return 'Big Taxis';
  // MAXI CAB
  if (/(?:^|_)MAXI[_\s]*CAB(?:[\s_\[]|$)/i.test(up)) return 'Maxi Cab';
  // Plain BUS (after sort prefix)
  if (/(?:^|_)BUS(?:[\s_\[]|$)/i.test(up)) return 'Bus';
  // SCHOOL_BUS / STAFF_BUS with underscore
  if (/SCHOOL[_\s]*BUS/i.test(up)) return 'School Bus';
  if (/STAFF[_\s]*BUS/i.test(up)) return 'Staff Bus';

  return '';
}

/**
 * Infer Business Type (New / Renewal / Rollover) from segment / sub_type / remarks.
 * Chola uses markers like "1_TRAC[NEW]", "1_TRAC[RENEWAL]".
 */
function inferBusinessType(segment, subType, remarks, sheetName) {
  // 1. LLM-extract fallback first — natural-language phrasings ("old vehicle",
  //    "claim free renewal", typos) that regex can't enumerate.
  const llm = _llmGet(remarks);
  if (llm && typeof llm.business_type === 'string' && llm.business_type.length > 0) {
    return llm.business_type;
  }
  // 2. Sheet-name signal — many insurers (Shriram, Royal, etc.) put NB and
  //    rollover/renewal rates in dedicated sheets. The sheet name is the most
  //    reliable signal for those.
  const sn = String(sheetName || '').toUpperCase();
  if (sn) {
    if (/\b(?:ROLLOVE|ROLLOVER|RENEWAL)\b/.test(sn)) return 'Rollover';
    if (/\bNEW\s*BUSINESS\b|\bNB\b/.test(sn))         return 'New';
  }
  const s = [segment, subType, remarks].map(v => String(v || '')).join(' ').toUpperCase();
  if (/\[\s*NEW\s*\]/.test(s)) return 'New';
  if (/\[\s*RENEWAL\s*\]/.test(s)) return 'Renewal';
  if (/\[\s*ROLL\s*OVER\s*\]/.test(s) || /\[\s*ROLLOVER\s*\]/.test(s)) return 'Rollover';
  // ICICI Pvt Car col 13 ("Used car"): tagged via [USED CAR] / [USED] in
  // remarks so the export's BusinessType column reads "Used Car".
  if (/\[\s*USED(?:\s*CAR)?\s*\]/.test(s)) return 'Used Car';
  // Bare "OLD" / "OLD VEHICLE" / "USED" / "USED CAR" → Used.
  // Word-boundary match so "ROLLOVER" / "OLDS..." don't false-trigger.
  if (/\bOLD\b/.test(s) || /\bUSED\s*(?:CAR|VEHICLE)?\b/.test(s)) return 'Used';
  if (/\b(?:NEW\s+VEHICLES?|BRAND\s+NEW)\b/.test(s)) return 'New';
  if (/\bRENEWAL\b/.test(s)) return 'Renewal';
  if (/\bROLL\s*OVER\b|\bROLLOVER\b/.test(s)) return 'Rollover';
  return '';
}

/**
 * Infer Make from TW segment text.
 * "RE" → Royal Enfield, "MC_180-350_RE" → Royal Enfield,
 * "MC <= 180 Hero/Honda" → Hero/Honda
 */
function inferMakeFromSegment(segment) {
  if (!segment) return '';
  const s = String(segment).trim();
  // "RE" standalone or suffix: "MC_180-350_RE"
  if (/^RE$/i.test(s) || /_RE$/i.test(s) || /\bRE\b/.test(s) && !/\bREFER\b|\bREGION\b|\bREMARK/i.test(s)) {
    // Only match "RE" as Royal Enfield in short segments (TW context)
    if (s.length < 30 && /\bRE\b/.test(s)) return 'Royal Enfield';
  }
  // "MC <= 180 Hero/Honda" — make after MC CC pattern
  const m = s.match(/MC[^a-z]*\d+[^a-z]*?([A-Z][a-z]+(?:\s*\/\s*[A-Z][a-z]+)*)\s*$/);
  if (m) return m[1];
  return '';
}

/**
 * Infer Product (Comp / SAOD / TP) from rate_type first, then sheet name.
 *
 * Uses plain substring matching (not \b word boundaries) because rate_types
 * are often suffixed like "COMP_NON_NCB", "SAOD_NCB_2", "SATP_MAX_CD2",
 * "1+1_CD1", "CD2_Tata", "PACK", "ACT" — where underscores and other
 * non-letter chars break \b matching.
 *
 * Resolution order is most-specific-first:
 *   1. SATP / SAOD / COMP substring in rate_type
 *   2. ACT (TP) / PACK (Comp) — common Indian shorthand
 *   3. Bundled comp markers in rate_type (1+1, 1+3, 1+5, 5+5)
 *   4. Bare "TP" word in rate_type
 *   5. Sheet-name fallback (with same rules), only when rate_type was empty / unknown
 */
function inferProduct(rateType, sheetName, subType, segment) {
  const rt = String(rateType || '').toUpperCase();
  const aux = [subType, segment].map(v => String(v || '').toUpperCase()).join(' ');

  // ── Primary: Section Text encoded in rate_type ───────────────────────
  // Pivot insurers (TATA, etc.) bake the Section Text into rate_type, e.g.
  //   "DM|Package|Slab 1"   → Comp
  //   "DM|SATP|Slab 7"      → TP
  //   "DM|SAOD|NCB:Yes"     → SAOD
  //   "Comp_OD" / "Comp_TP" → Comp / TP (ROBINHOOD-style)
  //
  // SATP must be checked before TP (SATP literally contains "TP"); SAOD
  // must be checked before SOD (and before COMP since the substring
  // overlaps nothing). Bare PACKAGE / PACK / COMP all map to Comp.
  if (rt.includes('SATP'))           return 'TP';
  if (rt.includes('SAOD'))           return 'SAOD';
  // AOTP = Act Only TP (ICICI CV April long-form Policy Type column).
  // Must be checked BEFORE the generic COMP regex so "AOTP_Comp" maps
  // to TP, not Comp.
  if (/\bAOTP\b/.test(rt) || /^AOTP/.test(rt)) return 'TP';
  if (rt.includes('PACKAGE'))        return 'Comp';
  if (/\bCOMP\b/.test(rt) || /COMP_/.test(rt) || /_COMP/.test(rt)) return 'Comp';
  // "Comp_TP" → TP (compound rate_type with the PT suffix). Only applies
  // when there's an underscore-tagged TP segment in rate_type.
  if (/_TP\b|\bTP_/.test(rt))        return 'TP';

  // SOD / SAOD marker in sub_type / segment trumps a generic PACK rate_type
  // (e.g. Chola sub_type="PC [SOD]" with rate_type="PACK" → SAOD).
  if (/\b(?:SOD|SAOD)\b/.test(aux))  return 'SAOD';

  // ACT / PACK / SOD short forms (whole word or _-separated)
  if (/^ACT(_|$)|(^|_)ACT$/.test(rt) || /\bACT\b/.test(aux)) return 'TP';
  if (/^PACK(_|$)|(^|_)PACK$/.test(rt) || /\bPACK\b/.test(aux)) return 'Comp';
  if (/^SOD(_|$)|(^|_)SOD$/.test(rt)) return 'SAOD';

  // Bundled-comprehensive markers (1+1, 1+3, 1+5, 5+5) carried in rate_type
  if (/1\+1|1\+3|1\+5|5\+5/.test(rt)) return 'Comp';

  // Bare TP word in rate_type
  if (/(^|[^A-Z])TP([^A-Z]|$)/.test(rt)) return 'TP';

  // ── Secondary fallback: sheet-name only when rate_type carries no
  //    Section-Text marker. This catches Digit-style "TW 1+1 & SATP" /
  //    "Pvt Car SATP" sheets whose rate_type column is empty. Skipped
  //    entirely whenever the rule's rate_type already had a section tag.
  const s = String(sheetName || '').toLowerCase();
  if (/1\+1|1\+3|1\+5|5\+5/.test(s)) return 'Comp';
  if (s.includes('satp') || /\btp\b/.test(s)) return 'TP';
  const sheetHasSaod = s.includes('saod');
  const sheetHasComp = s.includes('comp');
  if (sheetHasSaod && !sheetHasComp) return 'SAOD';
  if (sheetHasComp && !sheetHasSaod) return 'Comp';

  return 'Comp';
}

/**
 * Map (rate_type, product) → "Applied on" (Net / OD / TP / Gross / OD+TP).
 *
 * The user's master template treats "Applied on" as the *premium basis*
 * (what the rate is calculated against), and in their rules:
 *   - SAOD product → Net basis
 *   - Comp product → Net basis
 *   - TP product   → TP basis
 *   - explicit OD+TP / Gross only when rate_type literally tags them
 *
 * Bare CD1 / CD2 / MAX_CD style rate_types are ignored as basis indicators
 * here — they describe a discount band, not a premium basis. The basis
 * comes from the resolved product instead.
 */
function inferAppliedOn(rateType, product, segment, remarks) {
  const rt = String(rateType || '').toUpperCase().replace(/\s+/g, '');

  // Explicit basis tags in rate_type override the product default
  if (rt.includes('OD+TP') || rt.includes('OD_TP') || rt.includes('ODTP')) return 'OD+TP';
  if (rt.includes('GROSS')) return 'Gross';
  if (rt.includes('NET')) return 'Net';
  if (/(^|[^A-Z])OD([^A-Z]|$)/.test(rt) && !rt.includes('SAOD')) return 'OD';

  // "Slab On - OD plus Add on" or "Slab Net 5" patterns in segment or remarks
  // Note: "0n" (zero-n) is a common typo for "On" in source data
  const slabSources = [segment, remarks].filter(Boolean);
  for (const src of slabSources) {
    const txt = String(src);
    // "Slab 0n - OD plus Add on" → OD+Addon
    if (/slab\s*[0o]n/i.test(txt)) {
      if (/od\s*(?:plus|\+)\s*add[\s-]?[0o]n/i.test(txt)) return 'OD+Addon';
      if (/od\s*(?:plus|\+)\s*tp/i.test(txt)) return 'OD+TP';
      if (/\bod\b/i.test(txt)) return 'OD';
      if (/\btp\b/i.test(txt)) return 'TP';
    }
    // "Slab Net 5" or "Slab Net" → Net
    if (/slab\s*net/i.test(txt)) return 'Net';
  }

  // Otherwise derive from product
  if (product === 'TP') return 'TP';
  if (product === 'SAOD' || product === 'Comp') return 'Net';

  return 'Net';
}

/**
 * Owned-by values used in sub_type for School & Staff Bus sheet.
 */
const OWNED_BY_VALUES = ['School', 'Company', 'Individual'];
function isOwnedByValue(subType) {
  return subType && OWNED_BY_VALUES.includes(subType);
}

/**
 * Infer "Owned By" from sub_type (where we store it), rate_type, or sheet context.
 * "In the name of School" → School, "On Contract (Transporter)" → Company,
 * "On Contract (Individual)" → Individual.
 */
function inferOwnedBy(subType, rateType, sheetName) {
  // Direct from sub_type (stored by parser from config owned_by)
  if (subType && OWNED_BY_VALUES.includes(subType)) return subType;

  // From rate_type text (legacy data or other configs)
  const rt = String(rateType || '');
  if (/transporter/i.test(rt) || /on\s*contract.*transporter/i.test(rt)) return 'Company';
  if (/individual/i.test(rt) || /on\s*contract.*individual/i.test(rt)) return 'Individual';
  if (/school/i.test(rt) || /name\s*of\s*school/i.test(rt)) return 'School';

  return '';
}

/**
 * Infer OD and TP tenure from rate_type and sheet name.
 *
 * Tenure patterns:
 *   "1+1"  → OD 1 yr, TP 1 yr    (bundled comprehensive 1-year)
 *   "1+3"  → OD 1 yr, TP 3 yr    (1-year OD + 3-year TP)
 *   "1+5"  → OD 1 yr, TP 5 yr
 *   "3+3"  → OD 3 yr, TP 3 yr
 *   "5+5"  → OD 5 yr, TP 5 yr
 *   "SATP" → TP only (standalone TP)
 *   "SAOD" → OD only (standalone OD)
 *   "MAX_1YR_CD2" → 1 year tenure
 *   "MAX_2YR_CD2" → 2 year tenure
 *   "(Payable over N Yrs)" → total tenure hint in sheet name
 *
 * @returns {{ od: number|string, tp: number|string }}
 */
function inferTenure(rateType, sheetName, remarks) {
  const rt = String(rateType || '').toUpperCase();
  const sn = String(sheetName || '');
  const rmk = String(remarks || '');

  // 0a. Explicit "Minimum Policy Period N days" / "N-day policy" / "Pro
  //     rata basis - N days" in remarks → emit "N/365" for both OD and
  //     TP (Shriram Short-term policy sheet uses this convention).
  let dm = rmk.match(/(?:minimum\s+policy\s+period|pro\s*rata\s*basis[^0-9]*?|policy\s+period[^0-9]*?)(\d{1,3})\s*days?/i)
        || rmk.match(/\b(\d{1,3})\s*[-\s]?day\s+(?:policy|pro\s*rata|tenure)/i)
        || rmk.match(/short[\s-]*term[^0-9]*(\d{1,3})\s*days?/i);
  if (dm) {
    const days = parseInt(dm[1], 10);
    if (days > 0 && days < 365) {
      const frac = days + '/365';
      return { od: frac, tp: frac };
    }
  }

  // 0b. Short-term policy sheet (no explicit day count) — keep the
  //     legacy fractional sentinels 0.1 / 0.11 per business convention.
  if (/short[\s_]*term/i.test(sn)) return { od: 0.1, tp: 0.11 };

  // 1. Standalone TP (SATP) in rate_type — always TP only, regardless of sheet name
  if (rt.includes('SATP')) return { od: '', tp: 1 };

  // 2. Standalone OD (SAOD) in rate_type — OD only, no TP
  if (rt.includes('SAOD')) return { od: 1, tp: '' };

  // 3. Explicit N+N pattern in rate_type or sheet name
  let m = rt.match(/(\d)\+(\d)/);
  if (!m) m = sn.match(/(\d)\+(\d)/);
  if (m) return { od: parseInt(m[1], 10), tp: parseInt(m[2], 10) };

  // 4. Standalone from sheet name only (when rate_type had no hint)
  if (/\bSATP\b/i.test(sn)) return { od: '', tp: 1 };
  if (/\bSAOD\b/i.test(sn)) return { od: 1, tp: '' };

  // 4. Year-specific rate_type: "MAX_1YR_CD2", "MAX_2YR_CD2", etc.
  m = rt.match(/(\d)YR/);
  if (m) {
    const yrs = parseInt(m[1], 10);
    // These are typically SAOD flexi options → OD tenure
    return { od: yrs, tp: '' };
  }

  // 5. "(Payable over N Yrs)" in sheet name
  m = sn.match(/payable\s+over\s+(\d+)\s*yr/i);
  if (m) {
    const total = parseInt(m[1], 10);
    return { od: total, tp: total };
  }

  // 6. Comp product with no explicit tenure → default 1+1. Matches Shriram's
  //    PACK_SHRIRAM_* / PACK% prefix family and the generic "Comp" sheet
  //    naming convention.
  if (rt.includes('COMP') || rt.includes('PACK') || /\bComp\b/i.test(sn)) {
    return { od: 1, tp: 1 };
  }

  return { od: '', tp: '' };
}

/**
 * Derive NCB (No-Claim Bonus) band from rate_type suffix when the DB's
 * age_band_min/max is null.
 *
 * Rules:
 *   - rate_type contains "_NON_NCB" → NCB = 0 to 0  (customer has no NCB)
 *   - rate_type contains "_NCB" (without "_NON_NCB") → NCB = 1 to 100  (any NCB level)
 *   - Otherwise → use whatever the DB has (may be blank)
 */
function inferNCB(rateType, dbMin, dbMax, auxText, remarks) {
  const rt = String(rateType || '').toUpperCase();
  // LLM-extract fallback — when the regex pipeline misses (typo variants
  // like "with out NCB", "with-out NCB", non-standard wording), prefer
  // the structured value the LLM extracted from the same remark text.
  //
  // Hallucination guard: only honor the LLM's NCB extract when the original
  // remark text actually contains "NCB". Otherwise the model is making it
  // up — e.g. "SC upto (3+1)" got mistakenly extracted as ncb_max: 3
  // because the model saw "3+1" and pattern-matched. The remark must
  // mention NCB for the LLM extract to be trustworthy here.
  const remarkHasNcb = /\bNCB\b/i.test(String(remarks || ''));
  const llm = _llmGet(remarks);
  if (remarkHasNcb && llm && (Number.isFinite(llm.ncb_min) || Number.isFinite(llm.ncb_max))) {
    // Sanity bounds — NCB is 0-100. Reject negative or out-of-range values.
    const inRange = (v) => Number.isFinite(v) && v >= 0 && v <= 100;
    if (inRange(llm.ncb_min) || inRange(llm.ncb_max)) {
      return {
        min: inRange(llm.ncb_min) ? llm.ncb_min : '',
        max: inRange(llm.ncb_max) ? llm.ncb_max : '',
        also_blank: true,
      };
    }
  }

  // Pivot / flat-table tag: rate_type carries "NCB:Yes" / "NCB:No"
  // (TATA pci checks → "DM|Package|Slab 1|NCB:Yes",
  //  TATA Pvt Pkg → "Package_OD|NCB:Yes").  By spec:
  //    NCB:Yes  → MinNCB 1, MaxNCB 99
  //    NCB:No   → blank
  if (/NCB\s*[:=]\s*YES/.test(rt)) return { min: 1, max: 99 };
  if (/NCB\s*[:=]\s*NO\b/.test(rt))  return { min: '', max: '' };
  // ICICI Pvt Car convention: "with NCB > 0%" → Min 20 / Max 99 (renewal
  // rolling NCB from 20% upward); "Non NCB renewal/rollover" → Min 0 / Max 0.
  if (/NCB\s*[:=]\s*GT0\b/.test(rt))  return { min: 20, max: 99 };
  if (/NCB\s*[:=]\s*NONE\b/.test(rt)) return { min: 0,  max: 0  };

  // If the DB already has values, trust them
  if (dbMin != null || dbMax != null) {
    return { min: dbMin ?? '', max: dbMax ?? '' };
  }

  // Parse NCB range embedded in sub_type / segment / remarks text
  // Examples: "NCB GT 25%", "NCB > 25%", "NCB LT 25%", "NCB 20-50%", "NCB = 25%"
  if (auxText) {
    const parsed = parseNcbFromText(auxText);
    if (parsed && (parsed.min !== null || parsed.max !== null)) {
      // Propagate `also_blank` so the row emitter can fan out to a 2nd
      // blank-NCB row (covers policies with missing NCB info).
      return { min: parsed.min ?? '', max: parsed.max ?? '', also_blank: !!parsed.also_blank };
    }
  }

  // Derive from rate_type suffix
  if (rt.includes('_NON_NCB') || rt.includes('NON NCB')) {
    return { min: 0, max: 0 };
  }
  if (rt.includes('_NCB') || rt.includes(' NCB')) {
    return { min: 1, max: 100 };
  }

  return { min: '', max: '' };
}

/**
 * Parse a premium-volume band from `volume_tier` and return {min, max}
 * in lakhs.  Used to populate MinimumVolume / MaximunVolume in the export.
 *
 * Recognized formats (case-insensitive, suffix L/Lakhs/Lacs or K/Thousand):
 *   "Above 25L" / "Above 25 Lakhs" / "> 25L" / "25L+"  → { min: 25, max: '' }
 *   "1L-25L" / "1 - 25 Lakhs" / "1 to 25L"             → { min: 1,  max: 25 }
 *   "Below 25L" / "Upto 25L" / "< 25L"                  → { min: '', max: 25 }
 *   "0-50K" / "0 to 50K"                                → { min: 0,  max: 0.5 }   (K→L: ÷100)
 *   "50K-1L" / "50K to 1L"                              → { min: 0.5, max: 1 }    (Bajaj 2W)
 *   "Max Scooter"                                       → { min: '', max: '' }    (label, not a range)
 *
 * Returns { min: '', max: '' } when the field is absent or non-numeric
 * (e.g. SBI broker zone "East 1") so other layouts aren't disturbed.
 *
 * Implementation note: when "K" / "Thousand" appears, we convert that
 * number to lakhs (divide by 100).  Mixed K/L bands ("50K-1L") work
 * because we parse each side's unit independently.
 */
function parseVolumeBand(volumeTier) {
  const s = String(volumeTier || '').trim();
  if (!s) return { min: '', max: '' };
  // Require an "L" / "K" / "Lakhs" / "Lacs" / "Thousand" marker so this
  // doesn't false-match bare integer ranges (e.g. "65-69" — that's a
  // discount band, NOT a volume slab — Universal Sompo's sliding tiers).
  if (!/L|lakh|lac|K|thousand/i.test(s)) return { min: '', max: '' };

  // Per-side parser: "50K" → 0.5,  "1L" → 1,  "25 Lakhs" → 25
  const toLakhs = (numStr, unitStr) => {
    const n = parseFloat(numStr);
    if (!Number.isFinite(n)) return null;
    const u = (unitStr || '').toLowerCase();
    if (/^k|thousand/.test(u)) return +(n / 100).toFixed(4);   // K → L: /100
    return n;                                                   // L/Lakhs/Lacs/bare → L
  };

  const cleaned = s.replace(/lakhs?|lacs?/gi, 'L')
                    .replace(/thousand/gi, 'K')
                    .replace(/\s+/g, ' ');

  // Range form: "<a><unit>?-<b><unit>"  e.g. "0-50K" / "50K-1L" / "1L-25L"
  let m = cleaned.match(/^(\d+(?:\.\d+)?)\s*([KL])?\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)\s*([KL])?$/i);
  if (m) {
    const min = toLakhs(m[1], m[2]);
    const max = toLakhs(m[3], m[4]);
    if (min != null && max != null) return { min, max };
  }

  // "Above 25L" / "> 25L" / "25L+" / "3L+"  — open upper bound
  m = cleaned.match(/^(?:above|over|>)\s*(\d+(?:\.\d+)?)\s*([KL])?$/i)
   || cleaned.match(/^(\d+(?:\.\d+)?)\s*([KL])\s*\+$/i);
  if (m) return { min: toLakhs(m[1], m[2]), max: '' };

  // "Below 25L" / "Upto 25L" / "< 25L" — open lower bound
  m = cleaned.match(/^(?:below|under|upto|up\s*to|<)\s*(\d+(?:\.\d+)?)\s*([KL])?$/i);
  if (m) return { min: '', max: toLakhs(m[1], m[2]) };

  return { min: '', max: '' };
}

/**
 * Parse NCB range from free-text like "NCB GT 25%", "NCB > 25%",
 * "NCB LT 20%", "NCB 20-50%", "NCB = 25%". Returns {min, max} or null.
 * Convention (per user spec): GT/GTE both treated as inclusive lower bound.
 */
function parseNcbFromText(text) {
  const s = String(text || '').toUpperCase();
  if (!/\bNCB\b/.test(s)) return null;
  // Sentinel forms (Shriram broker grid uses these in UW remarks). For
  // both, we set `also_blank: true` so the row emitter emits a second
  // copy with NCB blank — covers policies whose NCB column is null /
  // missing even when the agent's intent matches the rule.
  //   "Without NCB cases" / "Non NCB" / "Non-NCB"     → NCB 0   + blank
  //   "NCB Cases" / "With NCB" / "NCB only" / "Only NCB" → NCB 1-99 + blank
  // The "Without"/"Non" check has to win when both phrases appear in the
  // same cell ("NCB cases / Non NCB-Break in cases ..."), so test it first.
  if (/(?:WITHOUT|NON)[\s-]*NCB/.test(s)) {
    return { min: 0, max: 0, also_blank: true };
  }
  // Lower-bound-qualified sentinel: "NCB Cases 20% and Above" / "NCB cases 25%+"
  // / "NCB Cases above 20" / "NCB only 25% & above" — must beat the plain
  // "NCB Cases" check below so the explicit lower bound is preserved.
  let lb;
  if (/\bNCB\b/.test(s) && (
        (lb = s.match(/(\d+)\s*%?\s*(?:AND|OR)?\s*(?:ABOVE|GT|GTE|>=?|MORE)/i))
     || (lb = s.match(/(\d+)\s*%?\s*\+/))
     || (lb = s.match(/(?:ABOVE|>=?|GTE?|MORE)\s*(\d+)\s*%?/))
     )) {
    const val = parseInt(lb[1], 10);
    if (val > 0 && val <= 100) {
      return { min: val, max: 99, also_blank: true };
    }
  }
  if (/\bNCB\s*CASES?\b|\bONLY\s*NCB\b|\bNCB\s*ONLY\b|\bWITH\s*NCB\b/.test(s)) {
    return { min: 1, max: 99, also_blank: true };
  }
  // "NCB A-B%" / "NCB A TO B%"
  let m = s.match(/NCB[^0-9]*?(\d+)\s*(?:-|TO|–)\s*(\d+)\s*%?/);
  if (m) return { min: parseInt(m[1], 10), max: parseInt(m[2], 10) };
  // "NCB GT N%" / "NCB > N%" / "NCB GTE N%" / "NCB >= N%" / "NCB ABOVE N%"
  m = s.match(/NCB[^0-9]*?(?:GTE?|>=?|ABOVE)\s*(\d+)\s*%?/);
  if (m) return { min: parseInt(m[1], 10), max: 100 };
  // "NCB LT N%" / "NCB < N%" / "NCB LTE N%" / "NCB <= N%" / "NCB UPTO N%" / "NCB BELOW N%"
  m = s.match(/NCB[^0-9]*?(?:LTE?|<=?|UPTO|UP\s*TO|BELOW)\s*(\d+)\s*%?/);
  if (m) return { min: 0, max: parseInt(m[1], 10) };
  // "NCB = N%" / "NCB EQ N%" / "NCB N%"
  m = s.match(/NCB[^0-9]*?(?:=|EQ)?\s*(\d+)\s*%?/);
  if (m) return { min: parseInt(m[1], 10), max: parseInt(m[1], 10) };
  return null;
}

/**
 * Extract body-type group prefix from rate_type.
 * Used to discriminate CD1/CD2 merge keys so that (e.g.) Non-Dumper CD1
 * does NOT merge with Dumper CD2 from the same Excel row.
 *
 * Examples:
 *   "COMP_CD1"                   → ""          (Non-Dumper, default)
 *   "DUMPER_COMP_CD1"            → "DUMPER"
 *   "PORT_TRAILER_SATP_MAX_CD2"  → "PORT_TRAILER"
 *   "OIL_TANKER_COMP_AVG_CD2"   → "OIL_TANKER"
 *   "GAS_TANKER_COMP_CD1"       → "GAS_TANKER"
 *   "CD1"                        → ""
 *   "MAX_CD2"                    → ""
 *   "1+1_CD1"                    → "1+1"
 */
function rateBodyGroup(rateType) {
  const rt = String(rateType || '').toUpperCase();
  const m = rt.match(/^(.*?)(?:COMP|SATP|CD[12]|AVG|MAX)/);
  if (!m) return '';
  return m[1].replace(/_$/, '');
}

/**
 * Detect if a rate_type represents a discount (CD1).
 * CD1 values are discounts and should go to min/max discount columns,
 * not the Rate % column.
 *
 * Examples:
 *   "CD1"            → true
 *   "COMP_CD1"       → true
 *   "1+1_CD1"        → true
 *   "DUMPER_CD1"     → true
 *   "DUMPER_COMP_CD1"→ true
 *   "1+5_CD1"        → true
 *   "5+5_CD1"        → true
 *   "MAX_CD2"        → false
 *   "SATP_MAX_CD2"   → false
 *   "COMP"           → false
 */
function isDiscountRate(rateType) {
  const rt = String(rateType || '').toUpperCase();
  // Match CD1 as a whole token: standalone, or preceded/followed by _ or boundary
  return /(^|[_\s])CD1([_\s]|$)/.test(rt);
}

/**
 * Derive HEV (High End Vehicle) flag from rate_type or fuel_type.
 *
 * If the column heading / rate_type contains "HEV" it means the rate is
 * specifically for High End Vehicles → flag = "Yes" (1).
 * Otherwise → "No".
 */
function inferHEV(rateType, fuelType, model, subType, segment) {
  // The export column is labelled "Highend" — the user wants Yes for
  // High End / Ultra High End vehicle types (TATA: "HE/UHE", "Premium",
  // some others use "High End", "Ultra High End", "Luxury"), and No
  // otherwise. We also keep the original HEV (hybrid-electric) trigger
  // since some Digit grids use that on the rate_type / fuel_type.
  const all = [rateType, fuelType, model, subType, segment]
    .map(v => String(v || '').toUpperCase())
    .join(' ');

  // Hybrid-electric tag in rate_type / fuel_type — both "HEV" and "Hybrid"
  // are recognised so engines that emit fuel_type='Hybrid' (e.g. Kotak)
  // get the Highend column flagged.
  if (/\bHEV\b/.test(all)) return 'Yes';
  if (/\bHYBRID\b/.test(all)) return 'Yes';
  // HE/UHE shorthand or spelled-out high-end markers
  if (/\bHE\s*\/\s*UHE\b/.test(all)) return 'Yes';
  if (/\bUHE\b/.test(all))           return 'Yes';
  if (/\bHE\b(?!\s*[A-Z])/.test(all)) return 'Yes';
  if (/HIGH[\s-]*END/.test(all))     return 'Yes';
  if (/ULTRA[\s-]*HIGH/.test(all))   return 'Yes';
  if (/\bLUXURY\b|\bPREMIUM\b/.test(all)) return 'Yes';

  return 'No';
}

/**
 * Parse tonnage (weight) range from segment text when the DB fields are null.
 *
 * All tonnage values in segment text include a "T" marker (1.6T, 2.5T, 20T…).
 * We require at least one "T" to distinguish tonnage numbers from age / CC numbers.
 *
 * Patterns handled (case-insensitive):
 *   "upto 1.6-2T"            → { min: 1.6, max: 2    }
 *   "upto 1.6T"              → { min: 0,   max: 1.6  }
 *   "UPTO_3.5T"              → { min: 0,   max: 3.5  }
 *   "up to 2.5T"             → { min: 0,   max: 2.5  }
 *   "1.6T to 2.5T"           → { min: 1.6, max: 2.5  }
 *   "1.6T-2.5T"              → { min: 1.6, max: 2.5  }
 *   "2T-2.5T"                → { min: 2,   max: 2.5  }
 *   "12 to 20T"              → { min: 12,  max: 20   }
 *   "40-44T"                 → { min: 40,  max: 44   }
 *   "2.5 T and Above"        → { min: 2.5, max: ''   }
 *   "44T+"                   → { min: 44,  max: ''   }
 */
function parseTonnageFromSegment(segment) {
  const s = String(segment || '');

  // "upto X-YT" → range X to Y  (e.g. "upto 1.6-2T") — require T at end
  let m = s.match(/up\s*to[_\s]*([\d.]+)\s*T?\s*[-–]\s*([\d.]+)\s*T\b/i);
  if (m) return { min: parseFloat(m[1]), max: parseFloat(m[2]) };

  // "upto XT" / "UPTO_XT" → range 0 to X — require T suffix
  m = s.match(/up\s*to[_\s]*([\d.]+)\s*T\b/i);
  if (m) return { min: 0, max: parseFloat(m[1]) };

  // "XT and Above" / "X T and Above" / "above XT" → min X, no max
  m = s.match(/([\d.]+)\s*T\s*(?:and\s+above)/i);
  if (m) return { min: parseFloat(m[1]), max: '' };
  m = s.match(/(?:above|>=?)[_\s]*([\d.]+)\s*T\b/i);
  if (m) return { min: parseFloat(m[1]), max: '' };

  // "XT+" / "44T+" → min X, no max
  m = s.match(/([\d.]+)\s*T\s*\+/i);
  if (m) return { min: parseFloat(m[1]), max: '' };

  // "XT to YT" / "XT-YT" / "X to YT" / "X-YT" / "XT_TO_YT" — require T on max side
  m = s.match(/([\d.]+)\s*T?\s*(?:_TO_|TO|[-–])\s*([\d.]+)\s*T\b/i);
  if (m) return { min: parseFloat(m[1]), max: parseFloat(m[2]) };

  // GCV context: range without T suffix — "GCV4 1.6 to 2.5" (followed by age or end)
  if (/^GCV/i.test(s)) {
    m = s.match(/GCV\d?\s+([\d.]+)\s*(?:to|[-–])\s*([\d.]+)(?:\s|$)/i);
    if (m) return { min: parseFloat(m[1]), max: parseFloat(m[2]) };
  }

  return { min: '', max: '' };
}

/**
 * Parse vehicle age range from segment text when the DB fields are null.
 *
 * First strips all tonnage patterns (numbers with T suffix) to avoid
 * false matches. Then looks for age patterns signalled by "years", "yrs",
 * "yr", or bare "N+" at end of string / before parenthetical.
 *
 * Patterns handled (case-insensitive):
 *   "0-5 years" / "0-5yrs" / "0-5 yr"  → { min: 0, max: 5 }
 *   "0 to 5 years"                      → { min: 0, max: 5 }
 *   "upto 0-2 years"                    → { min: 0, max: 2 }
 *   "age 0-2" / "age 0-2 years"         → { min: 0, max: 2 }
 *   "3+ years" / "5+" / "6+ yr"         → { min: 3, max: '' }
 */
function parseAgeFromSegment(segment) {
  const s = String(segment || '');

  // Strip tonnage patterns to avoid confusion with age numbers.
  // Order matters: strip "upto X T" as a unit first so "upto" doesn't orphan
  // and greedily consume the next number (which may be part of an age range).
  const cleaned = s
    .replace(/up\s*to[_\s]*([\d.]+)\s*T\b/gi, ' ')                  // "upto 1.6T" as unit
    .replace(/[\d.]+\s*T\s*(?:_TO_|to|[-–])\s*[\d.]+\s*T\b/gi, ' ') // "1.6T to 2.5T" / "1.6T_TO_2.5T"
    .replace(/[\d.]+\s*(?:_TO_|to|[-–])\s*[\d.]+\s*T\b/gi, ' ')     // "12 to 20T" / "12_TO_20T"
    .replace(/(?:above|>=?)\s*[\d.]+\s*T\b/gi, ' ')                  // "above 12T"
    .replace(/[\d.]+\s*T\b/gi, ' ')                                   // bare "2.5T"
    // Strip seating-band patterns so "Taxi 4-6 Seater" / "5 seater" /
    // "12 to 14 Seats" don't get re-interpreted as age ranges by the
    // bare "X-Y" fallback further down.
    .replace(/[\d.]+\s*(?:to|[-–])\s*[\d.]+\s*seat(?:er|s)?\b/gi, ' ')
    .replace(/[\d.]+\s*seat(?:er|s)?\b/gi, ' ');

  // "X-Y years" / "X-Yyrs" / "X to Y years" / "age X-Y"
  let m = cleaned.match(/(?:age\s+)?(\d+)\s*(?:to|[-–])\s*(\d+)\s*(?:years?|yrs?)\b/i);
  if (m) return { min: parseInt(m[1], 10), max: parseInt(m[2], 10) };

  // Bare "X-Y" after "age" keyword
  m = cleaned.match(/age\s+(\d+)\s*(?:to|[-–])\s*(\d+)/i);
  if (m) return { min: parseInt(m[1], 10), max: parseInt(m[2], 10) };

  // "X+ years" / "X+yrs" / "X+ yr"
  m = cleaned.match(/(\d+)\s*\+\s*(?:years?|yrs?)\b/i);
  if (m) return { min: parseInt(m[1], 10), max: '' };

  // "age X+"
  m = cleaned.match(/age\s+(\d+)\s*\+/i);
  if (m) return { min: parseInt(m[1], 10), max: '' };

  // Bare "X-Y" followed by "yrs"/"years" with optional whitespace
  m = cleaned.match(/(\d+)\s*[-–]\s*(\d+)\s*(?:yrs?)\b/i);
  if (m) return { min: parseInt(m[1], 10), max: parseInt(m[2], 10) };

  // Bare "X-Y" (no "years" keyword) — after tonnage stripped, remaining N-N is likely age
  m = cleaned.match(/(\d+)\s*[-–]\s*(\d+)(?:\s|$|\))/);
  if (m) return { min: parseInt(m[1], 10), max: parseInt(m[2], 10) };

  // Bare "N+" — after tonnage stripped, remaining N+ is likely age
  m = cleaned.match(/(\d+)\s*\+/);
  if (m) return { min: parseInt(m[1], 10), max: '' };

  return { min: '', max: '' };
}

/**
 * Normalize a numeric value to a whole-number percentage.
 *
 * The DB stores rates/discounts inconsistently:
 *   - Some engines store decimal fractions: 0.6 = 60%, 0.025 = 2.5%
 *   - Others store whole percentages:       22 = 22%, 85 = 85%
 *   - Conditional text always parsed as whole: "85%" → 85
 *
 * Rule: if 0 < |value| <= 1  → it's a fraction, multiply by 100
 *        if |value| > 1       → already a whole percentage
 *        if value == 0        → 0%
 *        if value is negative and > -1 → fraction (e.g. -0.05 = -5%)
 *
 * Exception: 1.225 is ambiguous but > 1, so it stays as-is (1.225%).
 * Values like 0.6, 0.8 become 60, 80 correctly.
 *
 * @param {number|string|null} val
 * @returns {number|string} Whole percentage number or '' if null/empty
 */
function normalizePercent(val) {
  if (val == null || val === '') return '';
  const num = Number(val);
  if (isNaN(num)) return '';
  if (num === 0) return 0;

  // Decimal fraction → multiply by 100
  if (Math.abs(num) > 0 && Math.abs(num) <= 1) {
    // Round to avoid floating point issues: 0.025 * 100 = 2.4999... → 2.5
    return Math.round(num * 10000) / 100;
  }

  return num;
}

/**
 * Infer Add-On flag (Yes / No / blank) from the DB addon field or rate_type.
 *
 * Rules:
 *   - "With Addon" / "addon" / "add-on" / "add on" → "Yes"
 *   - "Without Addon" / "no addon" / "w/o addon"  → "No"
 *   - Otherwise → '' (blank)
 */
function inferAddonFlag(addon) {
  if (!addon) return '';
  const s = String(addon).toLowerCase().trim();

  // "Without Addon", "Without Add on cover", "No Addon", "w/o addon", "without add-on"
  if (/without\s+add[\s-]?on|no\s+add[\s-]?on|w\/o\s+add[\s-]?on/i.test(s)) return 'No';
  // "With Addon", "With Add on cover", "addon", "add-on", "add on"
  if (/with\s+add[\s-]?on|^addon$|^add[\s-]?on$|^add[\s-]?on\s+cover$/i.test(s)) return 'Yes';
  // Shorthand single-char / single-word flags (Y/N, Yes/No, true/false)
  // — used by engines that stash addon as a flag rather than free text
  // (e.g. Reliance Pvt Car Addon Bundle Tyre/RTI sourced rule).
  if (/^(y|yes|true|1)$/i.test(s)) return 'Yes';
  if (/^(n|no|false|0)$/i.test(s)) return 'No';

  return '';
}

/**
 * Parse fuel types from segment text or DB fuel_type field.
 * Handles multi-fuel like "Petrol/CNG" or "Diesel/CNG" by splitting on / or &.
 *
 * Examples:
 *   "GCV4 3.5 To 7.5T-Petrol/CNG"   → ['Petrol', 'CNG']
 *   "GCV4 upto 2.5T-Diesel"          → ['Diesel']
 *   "Petrol/CNG"                      → ['Petrol', 'CNG']
 *   "Electric"                        → ['Electric']
 *   "Petrol / CNG / EV"              → ['Petrol', 'CNG', 'EV']
 *   ""                                → ['']
 *
 * @param {string} fuelType - DB fuel_type field
 * @param {string} segment  - segment text to parse from
 * @returns {string[]} Array of individual fuel types
 */
function parseFuelTypes(fuelType, segment) {
  // First try DB fuel_type
  let raw = String(fuelType || '').trim();

  // If DB has no fuel, try extracting from segment
  if (!raw && segment) {
    const seg = String(segment);
    // Look for fuel type after hyphen or dash at end: "GCV4 3.5 To 7.5T-Petrol/CNG"
    const fuelWord = '(?:Petrol|Diesel|CNG|Electric|EV|LPG|Hybrid)';
    const fuelListRe = new RegExp(`(${fuelWord}(?:\\s*[\\/&]\\s*${fuelWord})*)\\s*$`, 'i');
    let m = seg.match(new RegExp(`[-–]\\s*${fuelListRe.source}`, 'i'));
    if (m) raw = m[1];

    // Also match standalone fuel list in segment: "Petrol/CNG", "Petrol / CNG / EV"
    if (!raw) {
      m = seg.match(fuelListRe);
      if (m && m[1].includes('/')) raw = m[1]; // require / to avoid matching bare "Diesel" in middle of text
    }

    // Also check bracket notation: "[D]", "[P]", "[CNG]"
    if (!raw) {
      m = seg.match(/\[(D|P|CNG|EV)\]/i);
      if (m) {
        const code = m[1].toUpperCase();
        if (code === 'D') raw = 'Diesel';
        else if (code === 'P') raw = 'Petrol';
        else raw = code;
      }
    }

    // Check for fuel keywords in segment
    if (!raw) {
      const lower = seg.toLowerCase();
      if (/e[\s-]?(rickshaw|loader)/i.test(seg) || /\belectric\b/i.test(lower)) raw = 'Electric';
      // KW patterns imply Electric: "3-7 KW", "< 3 KW", "> 7 KW"
      else if (/\d+\s*KW\b/i.test(seg) || /[<>=]\s*\d+\s*KW/i.test(seg)) raw = 'Electric';
      // EV suffix/prefix: "SC/EV", "SC_EV", "SCOOTER/EV", standalone "EV"
      else if (/\bEV\b/i.test(seg)) raw = 'Electric';
      else if (/non[\s-]?diesel/i.test(lower)) raw = 'Petrol / CNG / EV';
      else if (/\bcng\b/i.test(lower)) raw = 'CNG';
      else if (/\bdiesel\b/i.test(lower)) raw = 'Diesel';
      else if (/\bpetrol\b/i.test(lower)) raw = 'Petrol';
    }
  }

  if (!raw) return [''];

  // Split on / or & (with optional spaces) to get individual fuel types
  const parts = raw.split(/\s*[\/&]\s*/).map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return [''];

  // Normalize each part
  return parts.map(p => {
    const lower = p.toLowerCase().trim();
    if (lower === 'ev') return 'Electric';
    if (lower === 'cng') return 'CNG';
    if (lower === 'lpg') return 'LPG';
    if (lower === 'diesel') return 'Diesel';
    if (lower === 'petrol') return 'Petrol';
    if (lower === 'electric') return 'Electric';
    if (lower === 'hybrid') return 'Hybrid';
    // Capitalize first letter for anything else
    return p.charAt(0).toUpperCase() + p.slice(1);
  });
}

// ---------- Conditional rate text expansion ----------

/**
 * Parse conditional rate text into an array of expanded entries.
 * Each entry carries overrides for the fields that differ (e.g. vehicle_age_min/max, rate_value).
 *
 * Handles these pattern families (in priority order):
 *
 * 1. Age-based:
 *    "Age 0-2: 45%\r\nAge 3+: 55%"
 *    "Age 0 to 5-10%\r\nAge>=6 -12.5%"
 *    "Age 0: 17.5%\r\nAge>=1: 15%"
 *    "0 to 1 yr : 17.5%\r\n2 to 5 yr : 28.0%"
 *    "Age0-5: 10%\r\nAge 6+: 35%"
 *    "0 to 5 age-20%\r\n>5 years-12%"
 *
 * 2. Tonnage-based:
 *    "40-44T: 22.5%\r\n44T+: 2.5%"
 *
 * 3. CD1/CD2 combined:
 *    "CD1 95% / CD2 27.5%"
 *
 * 4. Make-based:
 *    "Non TATA: 15%\r\nTATA: 17%"
 *    "Tata: 25%\r\nOther Makes: 25.5%/23.5%"
 *
 * 5. Addon-based:
 *    "With Addon: 15%\r\nWithout Addon: 10%"
 *
 * 6. Region-based:
 *    "West Bengal: 15%\r\nNorth Bengal: 22.5%"
 *
 * 7. Slash-separated (fallback):
 *    "15%/10%" — ambiguous, kept as single row with rate_text
 *
 * @param {string} rateText
 * @returns {Array<{overrides: object, rate_value: number|null, is_declined: boolean}>}
 */
function parseConditionalRateText(rateText) {
  if (!rateText) return [];
  const text = String(rateText).trim();
  if (!text) return [];

  // Split into lines/parts (by \r\n, \n, or multi-space blocks like "Age 0-5: 50%               Age 5+ : 55%")
  const lines = text.split(/\r?\n|(?<=\d%)\s{3,}(?=Age)/i).map(l => l.trim()).filter(Boolean);

  // --- 1. Age-based patterns ---
  const ageEntries = [];
  for (const line of lines) {
    // Try multiple age patterns per line
    const parsed = parseAgeLine(line);
    if (parsed) {
      ageEntries.push(parsed);
    }
  }
  if (ageEntries.length > 0 && ageEntries.length >= lines.length * 0.5) {
    return ageEntries;
  }

  // --- 2. Tonnage-based: "40-44T: 22.5%\r\n44T+: 2.5%" ---
  const tonnageEntries = [];
  for (const line of lines) {
    const parsed = parseTonnageLine(line);
    if (parsed) tonnageEntries.push(parsed);
  }
  if (tonnageEntries.length > 0 && tonnageEntries.length === lines.length) {
    return tonnageEntries;
  }

  // --- 3. CD1/CD2 combined: "CD1 95% / CD2 27.5%" ---
  const cdMatch = text.match(/CD1\s+([\d.]+)%?\s*\/\s*CD2\s+([\d.]+)%?/i);
  if (cdMatch) {
    return [
      { overrides: { _discount: parseFloat(cdMatch[1]) }, rate_value: parseFloat(cdMatch[2]), is_declined: false },
    ];
  }

  // --- 4. Make-based: "Non TATA: 15%\r\nTATA: 17%" or "Tata: 25%\r\nOther Makes: 28%/26%" ---
  const makeEntries = [];
  for (const line of lines) {
    const parsed = parseMakeLine(line);
    if (parsed) makeEntries.push(parsed);
  }
  if (makeEntries.length > 0 && makeEntries.length === lines.length) {
    return makeEntries;
  }

  // --- 5. Addon-based: "With Addon: 15%\r\nWithout Addon: 10%" ---
  const addonEntries = [];
  for (const line of lines) {
    const parsed = parseAddonLine(line);
    if (parsed) addonEntries.push(parsed);
  }
  if (addonEntries.length > 0 && addonEntries.length === lines.length) {
    return addonEntries;
  }

  // --- 6. Region-based: "West Bengal: 15%\r\nNorth Bengal: 22.5%" ---
  const regionEntries = [];
  for (const line of lines) {
    const parsed = parseRegionLine(line);
    if (parsed) regionEntries.push(parsed);
  }
  if (regionEntries.length > 0 && regionEntries.length === lines.length) {
    return regionEntries;
  }

  // --- 7. NCB-based: "with NCB/break in > 90 days : 80%, without NCB : 70%" ---
  const ncbParts = text.split(/,\s*/);
  const ncbEntries = [];
  for (const part of ncbParts) {
    const parsed = parseNcbLine(part.trim());
    if (parsed) ncbEntries.push(parsed);
  }
  if (ncbEntries.length > 0 && ncbEntries.length === ncbParts.length) {
    return ncbEntries;
  }

  // --- 8. Slash-separated fallback ---
  // "15%/10%" → keep as-is (too ambiguous to expand meaningfully)
  // Return empty = no expansion, original row is kept
  return [];
}

/**
 * Parse a single line for age-based conditional rate.
 * Returns { overrides: {vehicle_age_min, vehicle_age_max}, rate_value, is_declined } or null.
 */
function parseAgeLine(line) {
  const s = line.trim();
  let m;

  // Check for "Declined" value
  const isDeclined = /declined/i.test(s);

  // Extract rate value — handle slash-separated like "47.5%/35%" (take first value)
  const rateMatch = s.match(/([\d.]+)\s*%/);
  const rateValue = rateMatch ? parseFloat(rateMatch[1]) : null;

  // "Age X-Y: Z%" or "Age X-Y -Z%" or "AgeX-Y: Z%"
  m = s.match(/^Age\s*(\d+)\s*[-–]\s*(\d+)\s*[:\-]\s*/i);
  if (m) {
    return {
      overrides: { vehicle_age_min: parseInt(m[1], 10), vehicle_age_max: parseInt(m[2], 10) },
      rate_value: rateValue, is_declined: isDeclined,
    };
  }

  // "Age 0 to 5-Z%" or "Age 0 to 5 : Z%" or "Age 0 to 5: Z%"  or "Age 2 to 5:16.5%"
  m = s.match(/^Age\s*(\d+)\s+to\s+(\d+)\s*[:\-]\s*/i);
  if (m) {
    return {
      overrides: { vehicle_age_min: parseInt(m[1], 10), vehicle_age_max: parseInt(m[2], 10) },
      rate_value: rateValue, is_declined: isDeclined,
    };
  }

  // "Age X: Z%" or "AgeX: Z%" (single age)
  m = s.match(/^Age\s*(\d+)\s*:\s*/i);
  if (m) {
    const age = parseInt(m[1], 10);
    return {
      overrides: { vehicle_age_min: age, vehicle_age_max: age },
      rate_value: rateValue, is_declined: isDeclined,
    };
  }

  // "Age>=X: Z%" or "Age>=X -Z%" or "Age >=X: Z%"
  m = s.match(/^Age\s*>=?\s*(\d+)\s*[:\-]\s*/i);
  if (m) {
    return {
      overrides: { vehicle_age_min: parseInt(m[1], 10), vehicle_age_max: 99 },
      rate_value: rateValue, is_declined: isDeclined,
    };
  }

  // "Age X+: Z%" or "Age X+Z%" or "AgeX+: Z%"
  m = s.match(/^Age\s*(\d+)\s*\+\s*[:\-]?\s*/i);
  if (m) {
    return {
      overrides: { vehicle_age_min: parseInt(m[1], 10), vehicle_age_max: 99 },
      rate_value: rateValue, is_declined: isDeclined,
    };
  }

  // "X to Y yr : Z%" or "X to Y yr: Z%" (no "Age" prefix)
  m = s.match(/^(\d+)\s+to\s+(\d+)\s*(?:yr|yrs|year|years)\s*:\s*/i);
  if (m) {
    return {
      overrides: { vehicle_age_min: parseInt(m[1], 10), vehicle_age_max: parseInt(m[2], 10) },
      rate_value: rateValue, is_declined: isDeclined,
    };
  }

  // "X+ yr : Z%" (no "Age" prefix)
  m = s.match(/^(\d+)\s*\+\s*(?:yr|yrs|year|years)\s*:\s*/i);
  if (m) {
    return {
      overrides: { vehicle_age_min: parseInt(m[1], 10), vehicle_age_max: 99 },
      rate_value: rateValue, is_declined: isDeclined,
    };
  }

  // "0 to 5 age-Z%" or ">5 years-Z%"
  m = s.match(/^(\d+)\s+to\s+(\d+)\s*(?:age|years?)\s*[-:]\s*/i);
  if (m) {
    return {
      overrides: { vehicle_age_min: parseInt(m[1], 10), vehicle_age_max: parseInt(m[2], 10) },
      rate_value: rateValue, is_declined: isDeclined,
    };
  }

  // ">X years-Z%" or ">X years: Z%"
  m = s.match(/^>\s*(\d+)\s*(?:years?|yrs?)\s*[-:]\s*/i);
  if (m) {
    return {
      overrides: { vehicle_age_min: parseInt(m[1], 10) + 1, vehicle_age_max: 99 },
      rate_value: rateValue, is_declined: isDeclined,
    };
  }

  // "Age 0-85%" → tricky edge case: Age 0, rate 85% (the dash is separator, not range)
  m = s.match(/^Age\s*(\d+)\s*-([\d.]+)%/i);
  if (m && parseFloat(m[2]) > 15) { // rate values > 15 are likely rates, not age ranges
    const age = parseInt(m[1], 10);
    return {
      overrides: { vehicle_age_min: age, vehicle_age_max: age },
      rate_value: parseFloat(m[2]), is_declined: isDeclined,
    };
  }

  return null;
}

/**
 * Parse a tonnage-based conditional line.
 * "40-44T: 22.5%" or "44T+: 2.5%"
 */
function parseTonnageLine(line) {
  const s = line.trim();
  let m;

  // "XT-YT: Z%" or "X-YT: Z%"
  m = s.match(/^([\d.]+)\s*T?\s*[-–]\s*([\d.]+)\s*T\s*:\s*([\d.]+)\s*%/i);
  if (m) {
    return {
      overrides: { weight_band_min: parseFloat(m[1]), weight_band_max: parseFloat(m[2]) },
      rate_value: parseFloat(m[3]), is_declined: false,
    };
  }

  // "XT+: Z%"
  m = s.match(/^([\d.]+)\s*T\s*\+\s*:\s*([\d.]+)\s*%/i);
  if (m) {
    return {
      overrides: { weight_band_min: parseFloat(m[1]), weight_band_max: null },
      rate_value: parseFloat(m[2]), is_declined: false,
    };
  }

  return null;
}

/**
 * Parse a make-based conditional line.
 * "Non TATA: 15%" or "TATA: 17%" or "Other Makes: 28%/26%"
 */
function parseMakeLine(line) {
  const s = line.trim();
  const m = s.match(/^(.+?):\s*([\d.]+)\s*%/);
  if (!m) return null;

  const label = m[1].trim();
  const rateValue = parseFloat(m[2]);

  // Must look like a make condition (not age/addon/region)
  if (/^age|^with|^without|^\d|^>|^ncb/i.test(label)) return null;
  if (/tata|make|maruti|hyundai|mahindra|kia|toyota/i.test(label)) {
    return {
      overrides: { _make_condition: label },
      rate_value: rateValue, is_declined: false,
    };
  }

  return null;
}

/**
 * Parse an addon-based conditional line.
 * "With Addon: 15%" or "Without Addon: 10%"
 */
function parseAddonLine(line) {
  const s = line.trim();
  const m = s.match(/^(With(?:out)?\s+Addon)\s*:\s*([\d.]+)\s*%/i);
  if (!m) return null;
  const label = m[1].trim();
  const isWithAddon = /^With\s+Addon$/i.test(label); // "With Addon" = Yes, "Without Addon" = No
  return {
    overrides: { _addon_condition: label, _addon_flag: isWithAddon ? 'Yes' : 'No' },
    rate_value: parseFloat(m[2]), is_declined: false,
  };
}

/**
 * Parse a region-based conditional line.
 * "West Bengal: 15%" or "North Bengal: 22.5%"
 */
function parseRegionLine(line) {
  const s = line.trim();
  const m = s.match(/^([A-Za-z\s]+?):\s*([\d.]+)\s*%/);
  if (!m) return null;

  const label = m[1].trim();
  // Must look like a region (not age/make/addon)
  if (/^age|^with|^without|^non|^tata|^\d|^>|^ncb|^cd[12]/i.test(label)) return null;
  if (/bengal|delhi|mumbai|kolkata|chennai|pune|north|south|east|west|zone|region/i.test(label)) {
    return {
      overrides: { _region_condition: label },
      rate_value: parseFloat(m[2]), is_declined: false,
    };
  }

  return null;
}

/**
 * Parse NCB-based conditional line.
 *
 * "with NCB/break in > 90 days : 80%"
 *   → NCB min:1 max:99, break_in_max:90, rate:80
 *
 * "without NCB : 70%"
 *   → NCB min:0 max:0, break_in_max:'', rate:70
 */
function parseNcbLine(line) {
  const s = line.trim();
  const m = s.match(/^(with(?:out)?\s+NCB.*?)\s*:\s*([\d.]+)\s*%/i);
  if (!m) return null;

  const label = m[1].trim();
  const isWithNCB = /^with\s+NCB/i.test(label) && !/^without/i.test(label);

  // Extract break-in days: "break in > 90 days" → 90
  let breakInMax = '';
  const breakMatch = label.match(/break[\s-]*in\s*[>]\s*(\d+)\s*days?/i);
  if (breakMatch) breakInMax = parseInt(breakMatch[1], 10);

  return {
    overrides: {
      _ncb_condition: label,
      _ncb_min: isWithNCB ? 1 : 0,
      _ncb_max: isWithNCB ? 99 : 0,
      _break_in_max: breakInMax,
    },
    rate_value: parseFloat(m[2]), is_declined: false,
  };
}

// ---------- DB fetch ----------

async function fetchRulesAndRtos(rateCardIds) {
  const pool = await getPool();

  // Build IN clause
  const ids = (Array.isArray(rateCardIds) ? rateCardIds : [rateCardIds])
    .map(n => parseInt(n, 10))
    .filter(n => Number.isInteger(n));
  if (ids.length === 0) return { rules: [], rtos: [] };

  const inClause = ids.map((_, i) => `@id${i}`).join(',');
  const reqRules = pool.request();
  const reqRtos = pool.request();
  // Export queries can be heavy (200k+ rows). Default 60s timeout from the
  // pool config is too tight after the new comment carve-outs blew rule
  // counts up. Raise per-request to 10 minutes.
  reqRules.timeout = 600000;
  reqRtos.timeout  = 600000;
  ids.forEach((id, i) => {
    reqRules.input(`id${i}`, sql.Int, id);
    reqRtos.input(`id${i}`, sql.Int, id);
  });

  const rulesResult = await reqRules.query(
    `SELECT rr.*, rc.effective_from AS _effective_from, rc.effective_to AS _effective_to, rc.uploaded_at AS _uploaded_at
     FROM rate_rules rr
     LEFT JOIN rate_cards rc ON rc.id = rr.rate_card_id
     WHERE rr.rate_card_id IN (${inClause})
     ORDER BY rr.rate_card_id, rr.id`
  );
  const rtosResult = await reqRtos.query(
    `SELECT insurer, product, rto_code, region, cluster
     FROM rto_mappings
     WHERE rate_card_id IN (${inClause})`
  );

  return { rules: rulesResult.recordset, rtos: rtosResult.recordset };
}

/**
 * Build a lookup map: key = `${insurer}||${region}` → { rtoCodes:Set, clusters:Set }
 * We join on (insurer, region) so a single rule's region can fan out to many RTOs.
 */
function buildRtoIndex(rtos) {
  // Index every mapper row under BOTH its region (state name) AND its
  // cluster value. This way:
  //   - rule.region = "Tamil Nadu" (state)         → hits the region key
  //   - rule.region = "CHENNAI" / "Vijaywada"      → hits the cluster key
  //     (Royal state CV grids put RTO Division in rule.region, which
  //     matches the mapper's cluster column for that LOB)
  //   - rule.region = "AHMEDABAD" / "ROWB1"        → hits the cluster key
  //     (TATA pivots use cluster names as rule.region)
  // A single mapper row gets inserted under both keys so a rule looking
  // up "Tamil Nadu" still gets all TN RTOs, and a rule looking up
  // "CHENNAI" gets only the Chennai-cluster RTOs.
  const idx = new Map();
  const addUnder = (insurer, label, r) => {
    if (!label) return;
    const key = `${insurer}||${String(label).toLowerCase().trim()}`;
    let entry = idx.get(key);
    if (!entry) {
      entry = { rtoCodes: new Set(), clusters: new Set() };
      idx.set(key, entry);
    }
    if (r.rto_code) entry.rtoCodes.add(String(r.rto_code).trim());
    if (r.cluster)  entry.clusters.add(String(r.cluster).trim());
  };
  for (const r of rtos) {
    const insurer = (r.insurer || '').toLowerCase();
    addUnder(insurer, r.region, r);
    addUnder(insurer, r.cluster, r);
  }
  return idx;
}

// ---------- State-name helpers ----------

// Canonical Indian state / UT names plus the most common spellings & shorthand
// the source files use. The lookup is case-insensitive and tolerant of
// spelling/abbreviation variations.
const INDIAN_STATE_CANONICAL = {
  'andhra pradesh': 'Andhra Pradesh', 'andhrapradesh': 'Andhra Pradesh', 'ap': 'Andhra Pradesh',
  'ap & tlg': 'AP & Telangana', 'ap&tlg': 'AP & Telangana', 'ap and tlg': 'AP & Telangana',
  'ap & telangana': 'AP & Telangana', 'ap&telangana': 'AP & Telangana',
  'arunachal pradesh': 'Arunachal Pradesh',
  'assam': 'Assam',
  'bihar': 'Bihar',
  'chhattisgarh': 'Chhattisgarh', 'chattisgarh': 'Chhattisgarh',
  'goa': 'Goa',
  'gujarat': 'Gujarat',
  'haryana': 'Haryana',
  'himachal pradesh': 'Himachal Pradesh',
  'jharkhand': 'Jharkhand', 'jharkand': 'Jharkhand',
  'karnataka': 'Karnataka',
  'kerala': 'Kerala',
  'madhya pradesh': 'Madhya Pradesh',
  'maharashtra': 'Maharashtra',
  'manipur': 'Manipur',
  'meghalaya': 'Meghalaya',
  'mizoram': 'Mizoram',
  'nagaland': 'Nagaland',
  'odisha': 'Odisha', 'orissa': 'Odisha', 'odhisha': 'Odisha',
  'punjab': 'Punjab',
  'rajasthan': 'Rajasthan',
  'sikkim': 'Sikkim',
  'tamil nadu': 'Tamil Nadu', 'tamilnadu': 'Tamil Nadu', 'tn': 'Tamil Nadu',
  'tamilnadu & pondicherry': 'Tamil Nadu', 'tamil nadu & pondicherry': 'Tamil Nadu',
  'telangana': 'Telangana', 'telengana': 'Telangana',
  'tripura': 'Tripura',
  'uttar pradesh': 'Uttar Pradesh', 'uttarpradesh': 'Uttar Pradesh',
  'east up': 'East UP', 'west up': 'West UP',
  'uttarakhand': 'Uttarakhand', 'uttarakand': 'Uttarakhand',
  'west bengal': 'West Bengal',
  'delhi': 'Delhi', 'delhi-ncr': 'Delhi', 'delhi ncr': 'Delhi',
  'jammu & kashmir': 'Jammu & Kashmir', 'jammu and kashmir': 'Jammu & Kashmir', 'j&k': 'Jammu & Kashmir',
  'ladakh': 'Ladakh',
  'chandigarh': 'Chandigarh',
  'puducherry': 'Puducherry', 'pondicherry': 'Puducherry',
  'andaman nicobar': 'Andaman & Nicobar', 'andaman & nicobar': 'Andaman & Nicobar',
  // Additional UTs / shorthand variants seen in Royal PC STP / Pan India CV STP:
  'dadra nagar haveli': 'Dadra & Nagar Haveli', 'dadra & nagar haveli': 'Dadra & Nagar Haveli',
  'daman diu': 'Daman & Diu', 'daman & diu': 'Daman & Diu', 'daman   diu': 'Daman & Diu',
  'jammu kashmir': 'Jammu & Kashmir',
  'lakshadweep': 'Lakshadweep', 'lakshwadweep': 'Lakshadweep',
  'ncr': 'Delhi',                       // bare "NCR" → Delhi
  'north_east': 'North East', 'north east': 'North East',
};

function isIndianStateName(s) {
  if (!s) return false;
  // The remarks field can be compound — the parser appends RTO-override
  // hints / make-family notes after a "|" separator (e.g.
  //   "ANDHRA PRADESH | Only for AP16, AP17"). Match if ANY segment of
  // the compound string is a known state name.
  return _splitRemarksSegments(s).some(p =>
    Object.prototype.hasOwnProperty.call(INDIAN_STATE_CANONICAL, p)
  );
}

function canonicalStateName(s) {
  if (!s) return '';
  // Pull out the segment that's actually a state name when remarks is
  // compound. Falls back to the trimmed input when nothing matches.
  for (const p of _splitRemarksSegments(s)) {
    if (INDIAN_STATE_CANONICAL[p]) return INDIAN_STATE_CANONICAL[p];
  }
  return String(s).trim();
}

// Split a remarks-style compound string into normalised segments.  The
// parser concatenates state + override hints with " | " — splitting on
// that lets the state detector still fire when extra context is present.
function _splitRemarksSegments(s) {
  return String(s)
    .split('|')
    .map(p => p.replace(/\s+/g, ' ').trim().toLowerCase())
    .filter(Boolean);
}

// City → State inference. Used when a sheet provides a city in `region` but
// no state (e.g. ICICI Pvt Car PMG rows).  Keys are lowercased, alphanumeric
// only.  Values are canonical state names.
const INDIAN_CITY_TO_STATE = {
  'ahmedabad':'Gujarat','baroda':'Gujarat','vadodara':'Gujarat','rajkot':'Gujarat',
  'surat':'Gujarat','vapi':'Gujarat',
  'allahabad':'Uttar Pradesh','kanpur':'Uttar Pradesh','lucknow':'Uttar Pradesh',
  'varanasi':'Uttar Pradesh',
  'bangalore':'Karnataka','bengaluru':'Karnataka','mangalore':'Karnataka',
  'mysore':'Karnataka','mysuru':'Karnataka',
  'bhubaneshwar':'Odisha','bhubaneswar':'Odisha',
  'chennai':'Tamil Nadu','coimbatore':'Tamil Nadu','madurai':'Tamil Nadu',
  'tiruchy':'Tamil Nadu','kanchipuram':'Tamil Nadu','tiruvallur':'Tamil Nadu',
  'tiruppur':'Tamil Nadu',
  'chandigarh':'Chandigarh',
  'dehradun':'Uttarakhand',
  'goa':'Goa',
  'hyderabad':'Telangana',
  'indore':'Madhya Pradesh','bhopal':'Madhya Pradesh',
  'jaipur':'Rajasthan','jodhpur':'Rajasthan','udaipur':'Rajasthan','kota':'Rajasthan',
  'kochi':'Kerala','calicut':'Kerala','trivandrum':'Kerala',
  'kolkata':'West Bengal','calcutta':'West Bengal',
  'ludhiana':'Punjab','amritsar':'Punjab','jalandhar':'Punjab',
  'mumbai':'Maharashtra','pune':'Maharashtra','nagpur':'Maharashtra',
  'nasik':'Maharashtra','nashik':'Maharashtra','aurangabad':'Maharashtra',
  'ncr':'Delhi','delhi':'Delhi','newdelhi':'Delhi','gurgaon':'Haryana',
  'gurugram':'Haryana','noida':'Uttar Pradesh','faridabad':'Haryana',
  'patna':'Bihar',
  'ranchi':'Jharkhand','jamshedpur':'Jharkhand',
  'raipur':'Chhattisgarh',
  'vijaywada':'Andhra Pradesh','vijayawada':'Andhra Pradesh',
  'vishakapattnam':'Andhra Pradesh','visakhapatnam':'Andhra Pradesh',
  'vizag':'Andhra Pradesh','guntur':'Andhra Pradesh','krishna':'Andhra Pradesh',
};
function inferStateFromCity(city) {
  if (!city) return '';
  const k = String(city).toLowerCase().replace(/[^a-z0-9]/g, '');
  return INDIAN_CITY_TO_STATE[k] || '';
}

// Static metro-city → comma-joined RTO code list. Used at export time for
// rules whose region is a known metro city ("MUMBAI", "BANGALORE") so the
// RTOCode column can show the typical metro RTOs without requiring the
// engine to have done a workbook-side lookup. Codes deliberately kept to
// the most common ranges per metro — reflects what insurers usually mean
// by "Mumbai metro" / "Bangalore metro" / etc.
const METRO_CITY_TO_RTO_CODES = {
  mumbai: 'MH01, MH02, MH03, MH04, MH43, MH46, MH47, MH48',
  bangalore: 'KA01, KA02, KA03, KA04, KA05, KA41, KA50, KA51, KA53, KA57',
  bengaluru: 'KA01, KA02, KA03, KA04, KA05, KA41, KA50, KA51, KA53, KA57',
  chennai:   'TN01, TN02, TN03, TN04, TN05, TN06, TN07, TN09, TN10, TN11, TN12, TN13, TN14, TN18, TN19, TN20, TN22',
  hyderabad: 'TG07, TG08, TG09, TG10, TG11, TG12, TG13, TG14, TG15, AP09, AP10, AP11, AP12, AP13, AP28, AP29',
  secunderabad: 'TG07, TG08, TG09, TG10, TG11, TG12, TG13, TG14, TG15, AP09, AP10, AP11, AP12, AP13, AP28, AP29',
  delhi:    'DL01, DL02, DL03, DL04, DL05, DL06, DL07, DL08, DL09, DL10, DL11, DL12, DL13',
  ncr:      'DL01, DL02, DL03, DL04, DL05, DL06, DL07, DL08, DL09, DL10, DL11, DL12, DL13',
  kolkata:  'WB01, WB02, WB03, WB04, WB05, WB06, WB19, WB20, WB22, WB23',
  calcutta: 'WB01, WB02, WB03, WB04, WB05, WB06, WB19, WB20, WB22, WB23',
  ahmedabad:'GJ01, GJ27',
  pune:     'MH12, MH14',
  surat:    'GJ05, GJ28',
};
function lookupMetroRtoCodes(city) {
  if (!city) return null;
  const k = String(city).toLowerCase().replace(/[^a-z0-9]/g, '');
  return METRO_CITY_TO_RTO_CODES[k] || null;
}

function isRestOfIndiaMarker(s) {
  if (!s) return false;
  return /^rest\s*of\s*india$/i.test(String(s).trim());
}

function canonicalRestOfIndiaName(remarks, region) {
  if (isRestOfIndiaMarker(remarks)) return 'Rest of India';
  if (isRestOfIndiaMarker(region)) return 'Rest of India';
  return '';
}

/**
 * Decide what to put in the dedicated "Nil Dep" column. Only meaningful
 * for rules whose source carried an explicit Nil-Dep qualifier (Royal
 * state CV grids: "with or without Nil Dep" / "with Nil Dep" / "without
 * Nil Dep"). For other rules whose `addon` could be any kind of addon
 * we leave the column blank to avoid polluting it with unrelated tags.
 */
/**
 * Infer Compulsory Personal Accident (CPA) policy attached or not.
 * Yes / No / blank tri-state, mirroring inferNilDepFlag's contract.
 * Source text scan covers segment / sub_type / remarks. Patterns:
 *   "With CPA" / "CPA Yes" / "with CPA policy"  → 'Yes'
 *   "Without CPA" / "No CPA" / "CPA No"          → 'No'
 *   nothing mentioned                            → '' (not applicable)
 */
function inferCpa(rule) {
  // LLM-extract fallback first — catches "with out CPA" / typos that
  // regex doesn't anticipate. Hallucination guard: only honor LLM cpa
  // when the source remark text actually mentions CPA.
  const remarksHasCpa = /\bCPA\b/i.test(String(rule.remarks || ''));
  const llm = _llmGet(rule.remarks);
  if (remarksHasCpa && llm && (llm.cpa === 'Yes' || llm.cpa === 'No')) return llm.cpa;
  const text = [rule.segment, rule.sub_type, rule.remarks, rule.rate_type]
    .map(v => String(v || '')).join(' | ');
  if (!/CPA/i.test(text)) return '';
  if (/(?:WITHOUT|NO|NON)[\s-]*CPA\b/i.test(text)) return 'No';
  if (/CPA\s*[:=]?\s*NO\b/i.test(text))           return 'No';
  if (/\bWITH\s*CPA\b|CPA\s*[:=]?\s*YES|CPA\s*POLICY\b/i.test(text)) return 'Yes';
  return '';
}

/**
 * Parse an IDV cap from rule remarks / segment / sub_type. Common forms:
 *   "IDV upto 10 lacs"  / "IDV UPTO 10 LACS"        → max 1,000,000
 *   "IDV upto 15 lacs only" / "IDV upto 15 Lacs"    → max 1,500,000
 *   "IDV > 25 lacs" / "IDV ABOVE 25 lacs"           → min 2,500,001
 *   "IDV 5-25 lacs"                                 → min 500k, max 2.5M
 * Returns { min, max } as rupee values; either may be null.
 */
function parseIdvFromText(text, remarks) {
  // LLM-extract fallback first — catches "Insured Decleared Value 10 Lakhs"
  // / "max 10L" / typos that regex doesn't enumerate. Hallucination guard:
  // only trust LLM IDV when the source remark text actually mentions IDV.
  const remarksHasIdv = /\bIDV\b/i.test(String(remarks || ''));
  const llm = _llmGet(remarks);
  if (remarksHasIdv && llm && (Number.isFinite(llm.idv_min) || Number.isFinite(llm.idv_max))) {
    return {
      min: Number.isFinite(llm.idv_min) ? llm.idv_min : null,
      max: Number.isFinite(llm.idv_max) ? llm.idv_max : null,
    };
  }
  const s = String(text || '').toLowerCase();
  if (!/idv/.test(s)) return { min: null, max: null };
  const lakh = (n) => Math.round(parseFloat(n) * 100000);
  let m;
  if ((m = s.match(/idv[^\d]*upto\s+(\d+(?:\.\d+)?)\s*(?:lac|lakh)/i))
   || (m = s.match(/idv[^\d]*up\s+to\s+(\d+(?:\.\d+)?)\s*(?:lac|lakh)/i))) {
    return { min: null, max: lakh(m[1]) };
  }
  if ((m = s.match(/idv[^\d]*(?:above|>)\s*(\d+(?:\.\d+)?)\s*(?:lac|lakh)/i))) {
    return { min: lakh(m[1]) + 1, max: null };
  }
  if ((m = s.match(/idv[^\d]*(\d+(?:\.\d+)?)\s*(?:to|[-–])\s*(\d+(?:\.\d+)?)\s*(?:lac|lakh)/i))) {
    return { min: lakh(m[1]), max: lakh(m[2]) };
  }
  return { min: null, max: null };
}

function inferNilDepFlag(rule) {
  // The parser tags explicit Nil-Dep info onto rate_type:
  //   "_NilDep"   → source said "with Nil Dep"        → Yes
  //   "_NoNilDep" → source said "without Nil Dep"     → No
  //   neither    → source didn't mention Nil Dep     → BLANK (not applicable)
  // This three-state distinction matters because "with or without" cells
  // fan out to a Yes-row + a No-row, while plain "Upto 5 Years" cells
  // shouldn't claim either dep state.
  const rt = String(rule.rate_type || '');
  if (/(?:^|_)NoNilDep\b/i.test(rt)) return 'No';
  if (/(?:^|_)NilDep\b/i.test(rt))   return 'Yes';
  return '';
}

/**
 * Extract a discount band from a rule's text fields. Royal sheets carry
 * discount info inline rather than in a structured column:
 *   - PC Comp1 stores "Upto 20" / "20-50" / "50-60" / "60-70" / ">70" in
 *     the volume_tier column.
 *   - State CV segments embed "Dis Upto 80%" / "Dis Upto 90%" / "@ 80%
 *     discount" / "@ Upto 85% Discount" inside the segment text.
 *
 * Returns { min, max } as whole-percent ints, or null when nothing is
 * detectable. Caller decides whether to use it for `min discount` /
 * `Discount` columns.
 */
function inferRoyalDiscountBand(rule) {
  // 1. volume_tier — PC Comp1 layout
  const vt = String(rule.volume_tier || '').trim();
  if (vt) {
    let m = vt.match(/^\s*upto\s*(\d+)/i);
    if (m) return { min: 0, max: parseInt(m[1], 10) };
    m = vt.match(/^\s*>\s*(\d+)/);
    if (m) return { min: parseInt(m[1], 10), max: 100 };
    m = vt.match(/^\s*(\d+)\s*[-–to]+\s*(\d+)/i);
    if (m) return { min: parseInt(m[1], 10), max: parseInt(m[2], 10) };
  }
  // 2. segment text — state CV / 4W GCV EV / etc.
  const seg = String(rule.segment || '');
  if (seg) {
    let m = seg.match(/(?:Dis(?:count)?\s*)?Upto\s*(\d+)\s*%/i);
    if (m) return { min: 0, max: parseInt(m[1], 10) };
    m = seg.match(/@\s*Upto\s*(\d+)\s*%\s*Discount/i);
    if (m) return { min: 0, max: parseInt(m[1], 10) };
    m = seg.match(/@\s*(\d+)\s*%\s*(?:discount|disc)/i);
    if (m) return { min: parseInt(m[1], 10), max: parseInt(m[1], 10) };
    m = seg.match(/\bDis(?:count)?\s*(\d+)\s*[-to]+\s*(\d+)\s*%/i);
    if (m) return { min: parseInt(m[1], 10), max: parseInt(m[2], 10) };
    // Generic fallback: any "X% Discount" / "X% disc"
    m = seg.match(/(\d+)\s*%\s*(?:discount|disc)/i);
    if (m) return { min: parseInt(m[1], 10), max: parseInt(m[1], 10) };
  }
  // 3. rate_text — Royal cells like "10% (discount upto 80%)" /
  //    "IRDA with discount upto 70% only" / "9% (with dscount upto 80%)".
  //    The leading rate has been extracted into rate_value already; the
  //    discount cap lives only in rate_text so we mine it here.
  const rt = String(rule.rate_text || '');
  if (rt) {
    let m = rt.match(/d[is]?[is]?count\s*upto\s*(\d+(?:\.\d+)?)\s*%/i);
    if (m) return { min: 0, max: Math.round(parseFloat(m[1])) };
  }
  // 4. volume_tier as plain decimal / integer — Royal Tractor stores the
  //    OD Disc value directly (0.85 / 0.80 / 85 / 80). Treat as maximum
  //    discount (min = 0). Numbers <= 1 are treated as fractions and
  //    multiplied by 100; numbers > 1 (and ≤ 100) as raw percentages.
  if (vt) {
    const m = vt.match(/^\s*(\d+(?:\.\d+)?)\s*%?\s*$/);
    if (m) {
      const n = parseFloat(m[1]);
      const max = n <= 1 ? Math.round(n * 100) : Math.round(n);
      if (max >= 0 && max <= 100) return { min: 0, max };
    }
  }
  return null;
}

// ---------- Row mapping ----------

function ruleToRow(rule, rowIndex, rtoIndex, discount, fuelTypeOverride, opts) {
  const key = `${(rule.insurer || '').toLowerCase()}||${String(rule.region || '').toLowerCase()}`;
  const rtoEntry = rtoIndex.get(key);
  const allRtoCodes = rtoEntry ? Array.from(rtoEntry.rtoCodes) : [];
  const clusters = rtoEntry ? Array.from(rtoEntry.clusters).join(', ') : (rule.region || '');

  // RTO-code split: when sub_type is an RTO code (e.g. "MH34", "KA12",
  // "KL8A", "Others"), route it to the RTOCode column instead of Sub
  // Modal. Declared early so the rtoCodes resolution below can read it.
  const subTypeStr = String(rule.sub_type || '').trim();
  const isRtoLikeSubType =
    /^[A-Z]{2}\s*\d{1,3}[A-Z]?$/.test(subTypeStr) ||
    /^Others$/i.test(subTypeStr);
  const rtoFromSubType = isRtoLikeSubType ? subTypeStr.replace(/\s+/g, '') : null;

  // Engine-tagged "[RTO: ...]" prefix takes priority — used by Shriram's
  // 2W rollover sheet to surface the RTO GUIDELINES column verbatim.
  const rtoGuideMatch = String(rule.remarks || '').match(/^\[RTO:\s*([^\]]+)\]/i);
  const rtoGuideText  = rtoGuideMatch ? rtoGuideMatch[1].trim() : null;

  // Check for RTO-specific notes in remarks or segment text
  // e.g. "Only for AS05, AS07 RTOs" or "except UP32,UP33 and UP41"
  const rtoFromRemarks = parseRtoCodes(rule.remarks);
  const rtoFromSegment = parseRtoCodes(rule.segment);
  const rtoOverride = rtoFromRemarks || rtoFromSegment;

  let rtoCodes;
  if (rtoGuideText) {
    // Expand the RTO GUIDELINES cell into individual codes when possible.
    // "DL & NCR (UP-14,16,37 / HR-38,51,55,26)" → "UP14, UP16, UP37,
    // HR38, HR51, HR55, HR26" (parseRtoCodes pre-expands the compact
    // prefix-shared lists "UP-14,16,37" → "UP14,UP16,UP37").
    // Fallback: keep the verbatim text when parseRtoCodes finds no codes
    // (e.g. "AP ONLY" / "BR" — state markers, no explicit codes).
    const guideParsed = parseRtoCodes(rtoGuideText);
    if (guideParsed && guideParsed.only.length > 0) {
      rtoCodes = guideParsed.only.join(', ');
    } else if (guideParsed && guideParsed.except.length > 0) {
      const excluded = new Set(guideParsed.except);
      const universe = allRtoCodes.length > 0 ? allRtoCodes : [];
      rtoCodes = universe.filter(c => !excluded.has(c)).join(', ') || rtoGuideText;
    } else {
      rtoCodes = rtoGuideText;
    }
  } else if (rtoFromSubType) {
    // Engine put an RTO code (or "Others") into sub_type — surface it here.
    rtoCodes = rtoFromSubType;
  } else if (rtoOverride && rtoOverride.only.length > 0) {
    // "Only for XX, YY" → show only those specific RTOs
    rtoCodes = rtoOverride.only.join(', ');
  } else if (rtoOverride && rtoOverride.except.length > 0) {
    // "except XX, YY" → show all region RTOs minus the excluded ones
    const excluded = new Set(rtoOverride.except);
    rtoCodes = allRtoCodes.filter(c => !excluded.has(c)).join(', ');
  } else {
    rtoCodes = allRtoCodes.join(', ');
  }

  // Metro-city RTO fallback — when nothing populated RTOCode but the
  // rule's region OR remarks names a known metro city ("MUMBAI",
  // "BANGALORE", "Mumbai RTO codes"), surface that metro's typical RTO
  // list. Helps PCV Short-term policy rows that say "MUMBAI & GOA" /
  // "Bangalore RTO codes" but carry no explicit code list.
  if (!rtoCodes) {
    const metroFromRegion = lookupMetroRtoCodes(rule.region);
    if (metroFromRegion) {
      rtoCodes = metroFromRegion;
    } else if (rule.remarks) {
      // Try city words in remarks: "Mumbai RTO codes" / "Bangalore RTO codes"
      const cityM = String(rule.remarks).match(/\b(Mumbai|Bangalore|Bengaluru|Chennai|Hyderabad|Secunderabad|Delhi|Kolkata|Calcutta|Ahmedabad|Pune|Surat)\b/i);
      if (cityM) {
        const codes = lookupMetroRtoCodes(cityM[1]);
        if (codes) rtoCodes = codes;
      }
    }
  }

  const rateVal =
    rule.rate_value != null && !rule.is_declined
      ? normalizePercent(rule.rate_value)
      : '';

  const product = inferProduct(rule.rate_type, rule.sheet_name, rule.sub_type, rule.segment);
  const appliedOn = inferAppliedOn(rule.rate_type, product, rule.segment, rule.remarks);
  const ncbAux = [rule.sub_type, rule.segment, rule.remarks].filter(Boolean).join(' | ');
  let ncb = inferNCB(rule.rate_type, rule.age_band_min, rule.age_band_max, ncbAux, rule.remarks);
  // The caller may force NCB to blank for the "Without NCB Cases" companion
  // emission (so the rule covers both NCB=0 and NCB=blank policies — see
  // emitWithFuelExpansion's fan-out).
  if (opts && opts.ncbBlank) ncb = { min: '', max: '' };

  // Tonnage: prefer DB values, fall back to segment text parsing
  const dbTonMin = rule.weight_band_min;
  const dbTonMax = rule.weight_band_max;
  const segTon = (dbTonMin == null && dbTonMax == null) ? parseTonnageFromSegment(rule.segment) : { min: '', max: '' };
  const tonMin = dbTonMin ?? segTon.min;
  const tonMax = dbTonMax ?? segTon.max;

  // Vehicle age: prefer DB values, fall back to segment text parsing
  const dbAgeMin = rule.vehicle_age_min;
  const dbAgeMax = rule.vehicle_age_max;
  const segAge = (dbAgeMin == null && dbAgeMax == null) ? parseAgeFromSegment(rule.segment) : { min: '', max: '' };
  let vehAgeMin = dbAgeMin ?? segAge.min;
  let vehAgeMax = dbAgeMax ?? segAge.max;

  // "New Business" → age 0-0 (a brand-new vehicle is by definition age 0).
  // Triggers when ANY of the following say "New":
  //   - rule.sub_type / segment / model / remarks contain "brand new" /
  //     "new vehicles" (Shriram broker grid UW remarks);
  //   - the sheet name is the dedicated NB sheet (e.g. "New Business - 2W");
  //   - inferBusinessType (which consults LLM extract + sheet + remarks)
  //     resolves to "New".
  // Only applied when DB didn't already supply an age band — an explicit
  // "Upto 5 years" age column on a NB row would otherwise be silently
  // overwritten to 0-0.
  if (dbAgeMin == null && dbAgeMax == null) {
    const businessText = [rule.sub_type, rule.segment, rule.model, rule.remarks]
      .map(v => String(v || ''))
      .join(' ');
    const sheetUp = String(rule.sheet_name || '').toUpperCase();
    const isNewBusinessSheet = /\bNEW\s*BUSINESS\b|\bNB\b/.test(sheetUp);
    const businessType = inferBusinessType(rule.segment, rule.sub_type, rule.remarks, rule.sheet_name);
    if (isNewBusinessSheet
        || businessType === 'New'
        || /\bbrand\s*new\b|\bnew\s+vehicles?\b/i.test(businessText)) {
      vehAgeMin = 0;
      vehAgeMax = 0;
    }
  }

  // discount is injected externally by buildExportBuffer via merging — normalize to whole %
  let discountMin = normalizePercent(discount);
  let discountMax = normalizePercent(discount);
  // Royal-style fallback: when no merged-CD1 discount, try to read a band
  // out of volume_tier (PC Comp1) or segment text (state CV / 4W GCV EV).
  if (discountMin === '' && discountMax === '') {
    const royalBand = inferRoyalDiscountBand(rule);
    if (royalBand) {
      discountMin = royalBand.min;
      discountMax = royalBand.max;
    }
  }
  // Final fallback: rate_rules.discount_pct (Shriram's DIS % column lands
  // here directly; other engines can populate it whenever they expose
  // discount info). Used as both min and max since it's a single value
  // per row, not a band.
  if (discountMin === '' && discountMax === '' && rule.discount_pct != null) {
    const disc = normalizePercent(rule.discount_pct);
    if (disc !== '') { discountMin = disc; discountMax = disc; }
  }

  // CD1 rows that were NOT merged will have rateVal in discount, not Rate %
  const isCD1 = isDiscountRate(rule.rate_type);
  const ratePct = isCD1 ? '' : rateVal;

  // OD / TP / Netpoint split.  Three columns side-by-side:
  //   - Netpoint:  the single combined rate when neither OD nor TP is
  //                tagged on the rule (the default case).
  //   - OD Rate:   filled when the rule's rate_type / applied_on tags it
  //                as the OD half of an OD+TP pair (TATA "Comp_OD",
  //                Royal IRDA "Comp_IRDA_OD", 2w Comp Bike OD split).
  //   - TP Rate:   the matching TP half.
  //
  // Detection priority: explicit `applied_on` set on the rule (parser
  // attaches this in `splitOdTpCell` etc.), then suffix tags in rate_type
  // ("_OD" / "_TP" / "IRDA_OD" / "IRDA_TP"), else fall back to Netpoint.
  const odTpRates = (() => {
    // Merged OD+TP pair (from mergeOdTpPairs pre-processor) — both rates
    // belong to ONE Excel row.
    if (rule._od_tp_pair) {
      return {
        netpoint: '',
        od: rule._od_rate != null ? normalizePercent(rule._od_rate) : '',
        tp: rule._tp_rate != null ? normalizePercent(rule._tp_rate) : '',
      };
    }
    if (isCD1 || ratePct === '') return { netpoint: ratePct, od: '', tp: '' };
    const rt = String(rule.rate_type || '').toUpperCase();
    const ao = String(rule.applied_on || '').toUpperCase();
    const isOd = ao === 'OD' || /(?:^|[_|])OD(?:[_|]|$)/.test(rt) || /IRDA_OD/.test(rt);
    const isTp = ao === 'TP' || /(?:^|[_|])TP(?:[_|]|$)/.test(rt) || /IRDA_TP/.test(rt);
    // SATP must NOT match the TP pattern above — handled by SATP not
    // matching `(^|[_|])TP` (it starts with "SA").  Sanity check:
    if (rt.includes('SATP') && !rt.includes('IRDA_TP')) {
      // SATP is a section name, not a TP-half tag — leave OD/TP empty.
      return { netpoint: ratePct, od: '', tp: '' };
    }
    if (isOd) return { netpoint: '', od: ratePct, tp: '' };
    if (isTp) return { netpoint: '', od: '',      tp: ratePct };
    return { netpoint: ratePct, od: '', tp: '' };
  })();

  // CC: prefer DB values, fall back to segment OR sub_type OR remarks text
  // parsing. Handles KW, Watt, MC, "UPTO 1000 CC[ NCB GT 25%]", and
  // Shriram's "(Above 2000 Watt)" embedded in UW remarks.
  const dbCCMin = rule.cc_band_min;
  const dbCCMax = rule.cc_band_max;
  let ccMin = dbCCMin ?? '';
  let ccMax = dbCCMax ?? '';
  if (dbCCMin == null && dbCCMax == null) {
    for (const src of [rule.segment, rule.sub_type, rule.remarks]) {
      if (!src) continue;
      const segCC = parseCCBand(src);
      if (segCC.min != null || segCC.max != null) {
        ccMin = segCC.min ?? '';
        ccMax = segCC.max ?? '';
        break;
      }
    }
  }

  // Seating fallback: parse from sub_type first (Chola CV "PCCV<6"/"PCCV>6" lives
  // in the product/sub_type column, not segment), then segment, then remarks
  // (Shriram puts "SC upto (3+1)" in UW remarks).
  let seatFallback = { min: null, max: null };
  if (rule.seating_capacity_min == null && rule.seating_capacity_max == null) {
    for (const src of [rule.sub_type, rule.segment, rule.remarks]) {
      if (!src) continue;
      const s = parseSeatingCapacity(src);
      if (s.min != null || s.max != null) { seatFallback = s; break; }
    }
  }

  // Fuel type: use override if provided (from multi-fuel expansion), else resolve from DB/segment
  const fuelType = fuelTypeOverride || parseFuelTypes(rule.fuel_type, rule.segment)[0];

  // Add-On flag: from conditional expansion (_addon_flag) or DB addon field
  const addonFlag = rule._addon_flag || inferAddonFlag(rule.addon);

  // NCB: prefer overrides from conditional expansion, then DB, then infer from rate_type
  const ncbMin = rule._ncb_override_min !== undefined ? rule._ncb_override_min : ncb.min;
  const ncbMax = rule._ncb_override_max !== undefined ? rule._ncb_override_max : ncb.max;

  // Break-In: from conditional expansion, or from rate_type (e.g. "MAX_CD1_BREAKIN" → Yes)
  let breakIn = rule._break_in_max !== undefined ? rule._break_in_max : '';
  if (!breakIn) {
    const rtUpper = String(rule.rate_type || '').toUpperCase();
    if (/NO_?BREAKIN|NO_?BREAK_IN/i.test(rtUpper)) breakIn = 'No';
    else if (/BREAKIN|BREAK_IN/i.test(rtUpper)) breakIn = 'Yes';
  }

  // Owned By: from sub_type when it contains ownership info (School, Company, Individual)
  const ownedBy = inferOwnedBy(rule.sub_type, rule.rate_type, rule.sheet_name);

  // For Go-Digit-style "School & Staff Bus" sheets the segment column
  // encodes the state ("School Bus | Gujarat"), with region holding the
  // RTO/city. We only want to treat the segment as a state when it's
  // actually a Go-Digit-style "<School|Staff> Bus | <state>" / bare
  // "<School|Staff> Bus" segment. TATA's School Bus sheet uses different
  // segments like "PCV Bus School 31 to 50" (a vehicle subtype, not a
  // state) — those must NOT land in the State column.
  //
  // For Royal-style state CV grids the parser stores the state name in
  // `remarks` (col 0 of the source) and the RTO Division in `region`
  // (col 1). Surface them in the proper columns: State ← remarks, city
  // ← region, and blank the Zone (cluster) column unless the row is a
  // "Rest of India"-style catch-all. Detection is based on whether
  // `remarks` reads like an Indian state, so it works without an
  // insurer-specific switch.
  let stateCol = '';
  let cityCol = '';
  let zoneOverride = null;   // null = use default `clusters`; '' or string = override
  {
    const sn = String(rule.sheet_name || '');
    const segRaw = String(rule.segment || '').trim();
    const remarksStr = String(rule.remarks || '').trim();
    const regionStr = String(rule.region || '').trim();

    // First-class `state` column (added 2026-05). When the engine populated
    // it explicitly, treat that as authoritative — region/sub_type are then
    // free to carry city / RTO / qualifier without state-name overload.
    const stateField = String(rule.state || '').trim();
    if (stateField) {
      stateCol = canonicalStateName(stateField) || stateField;
      cityCol = regionStr;
      if (cityCol && canonicalStateName(cityCol) === stateCol) cityCol = '';
      // When the engine explicitly populates `state`, Zone shouldn't fall
      // back to the region (which now holds a city, not a cluster).  Blank
      // the Zone column unless an explicit zone marker exists on the rule.
      zoneOverride = '';
    }

    const looksLikeGoDigitBus = !stateCol &&
      /School.*Bus|Staff.*Bus/i.test(sn) &&
      /^(School Bus|Staff Bus)(\s*\||$)/i.test(segRaw);
    if (looksLikeGoDigitBus) {
      let seg = segRaw.replace(/^(School Bus|Staff Bus)\s*\|\s*/i, '').trim();
      if (/^(School Bus|Staff Bus)$/i.test(seg)) seg = '';
      stateCol = seg;
      cityCol = regionStr;
    } else if (!stateCol && remarksStr && isIndianStateName(remarksStr)) {
      // Royal state CV layout — remarks is state, region is city.
      stateCol = canonicalStateName(remarksStr);
      cityCol = regionStr;
      // When region equals the state (some sheets only have state-level
      // rows with no separate city column), don't duplicate it into the
      // city column — leave city blank.
      if (cityCol && canonicalStateName(cityCol) === stateCol) cityCol = '';
      // Zone column resolution priority for state-grid rows:
      //   1. "Rest of India" catch-all
      //   2. RS Zone stashed on `carrier_type` (Royal Taxi Comp / similar)
      //   3. Otherwise blank — Zone is only meaningful for state-grid
      //      rows when the source carries an explicit zone column
      const carrierStr = String(rule.carrier_type || '').trim();
      if (isRestOfIndiaMarker(remarksStr) || isRestOfIndiaMarker(regionStr)) {
        zoneOverride = canonicalRestOfIndiaName(remarksStr, regionStr);
      } else if (carrierStr) {
        // Anything explicitly stashed in carrier_type for a state-grid row
        // is treated as the Zone label — covers compass zones (Royal CV
        // East/West/North/South) as well as cluster tags (ICICI Pvt Car
        // EMG / PMG).
        zoneOverride = carrierStr;
      } else {
        zoneOverride = '';
      }
    } else if (!stateCol && regionStr && inferStateFromCity(regionStr)) {
      // City-only layout (ICICI Pvt Car PMG rows: region="MUMBAI", remarks
      // empty / non-state).  Infer state from a known city → state map and
      // populate State + City accordingly.  Zone preserved from carrier_type
      // if it looks like a zone marker (EMG / PMG / North / South / etc.).
      stateCol = inferStateFromCity(regionStr);
      cityCol = regionStr;
      const carrierStr = String(rule.carrier_type || '').trim();
      if (carrierStr) zoneOverride = carrierStr;
    } else if (!stateCol && /\bnew\s*car\b/i.test(sn)) {
      // Royal "New Car" broker scheme — Geography column (region) is a
      // free-text list of cities / states. State col stays blank (no
      // single state), city col carries the full geography string, and
      // Zone is blanked because the rtoIndex lookup against a multi-city
      // list never matches cleanly.
      cityCol = regionStr;
      zoneOverride = '';
    } else if (!stateCol && regionStr && isIndianStateName(regionStr)) {
      // Generic state-only rule (e.g. Universal Sompo non-cluster rows
      // where region = "PUDUCHERRY" / "TAMIL NADU" / etc.). Surface the
      // state into the State column; leave city/zone blank since the
      // rule isn't keyed off a sub-state cluster.
      stateCol = canonicalStateName(regionStr);
    }
  }

  // Tenure: OD and TP tenure from rate_type / sheet name (e.g. "1+3", "5+5", "SATP")
  const tenure = inferTenure(rule.rate_type, rule.sheet_name, rule.remarks);

  // NOP (Number of Policies) — parsed from volume_tier or sub_type.
  // Parser stores compact "NOP 100-500" / "NOP upto 30" / "NOP 500+" in volume_tier.
  // Fallback: parse raw "NEW(100-500 NOP)" from sub_type for older rows.
  const nop = parseNopForExport(rule.volume_tier, rule.sub_type);
  const nopMin = nop.min ?? '';
  const nopMax = nop.max ?? '';

  const dates = rateCardDates(rule);
  return [
    rowIndex,                                          // 1  Srno
    normalizeInsurer(rule.insurer),                    // 2  Insurer
    dates.start,                                       // 3  StartDate
    dates.end,                                         // 4  EndDate
    inferVehicleType(rule.sheet_name, rule.product, rule.segment, rule.sub_type), // 5  Vehile Type
    rule._vehicle_category || inferVehicleCategory(rule.segment, rule.rate_type, rule.sheet_name), // 4  Vehicle Category
    product,                                           // 5  Product
    rule.make || inferMakeFromSegment(rule.segment),    // 6  Make
    rule.model || '',                                  // 7  Modal
    isOwnedByValue(rule.sub_type) || isRtoLikeSubType ? '' : (rule.sub_type || ''), // 8  Sub Modal
    ownedBy,                                           // 9  Owned By
    fuelType,                                          // 10 Fuel Type
    ccMin,                                             // 10 Min CC
    ccMax,                                             // 11 Max CC
    (rule.seating_capacity_min ?? seatFallback.min ?? ''),  // 12 Min Seating
    (rule.seating_capacity_max ?? seatFallback.max ?? ''),  // 13 Max Seating
    vehAgeMin,                                         // 14 min Vehile age
    vehAgeMax,                                         // 15 Max Vehicle Age
    nopMin,                                            // 16 Min NOP
    nopMax,                                            // 17 Max NOP
    tonMin,                                            // 18 Min Tonnage
    tonMax,                                            // 19 Max Tonnage
    ...(() => {
      // IDV columns — populated when remarks/segment/sub_type carry an
      // "IDV upto N lacs" hint; left blank otherwise.
      for (const src of [rule.remarks, rule.segment, rule.sub_type]) {
        if (!src) continue;
        const idv = parseIdvFromText(src, rule.remarks);
        if (idv.min != null || idv.max != null) {
          return [idv.min ?? '', idv.max ?? ''];
        }
      }
      return ['', ''];
    })(),                                              // 18 min IDV / 19 Max IDV
    rtoCodes,                                          // 20 RTO code
    cityCol,                                           // 21 city
    stateCol,                                          // 22 State
    (() => {
      // Zone resolution priority:
      //   1. zoneOverride (Royal-style state CV layout)
      //   2. LLM extract (preferred — handles "Zone-2" / "BANGALORE ZONE")
      //   3. "ZONE 1/2/3" / "Zone 1" hint in remarks (regex)
      //   4. clusters (default — RTO mapper hit OR rule.region)
      if (zoneOverride !== null) return zoneOverride;
      const remarksHasZone = /\bZONE\b/i.test(String(rule.remarks || ''));
      const llmZone = _llmGet(rule.remarks);
      if (remarksHasZone && llmZone && typeof llmZone.zone === 'string' && llmZone.zone.length > 0) return llmZone.zone;
      const rmkZone = String(rule.remarks || '').match(/\bzone\s*[-:]?\s*([1-5])\b/i);
      if (rmkZone) return 'Zone ' + rmkZone[1];
      return clusters;
    })(),                                              // 23 Zone
    addonFlag,                                         // 24 Add-On
    inferNilDepFlag(rule),                             // 25 Nil Dep (Yes/No, only for state CV rules)
    inferCpa(rule),                                    // 25b CPA (Yes/No/blank from remarks)
    inferBusinessType(rule.segment, rule.sub_type, rule.remarks, rule.sheet_name), // 26 Business Type
    breakIn,                                           // 26 Break-In
    tenure.od,                                         // 26 OD_Tenure
    tenure.tp,                                         // 27 TP_Tenure
    discountMin,                                       // 28 min discount
    discountMax,                                       // 29 Max Discount
    ncbMin,                                            // 30 Min NCB
    ncbMax,                                            // 31 Max NCB
    parseVolumeBand(rule.volume_tier).min,             // MinimumVolume (lakhs)
    parseVolumeBand(rule.volume_tier).max,             // MaximunVolume (lakhs)
    inferHEV(rule.rate_type, rule.fuel_type, rule.model, rule.sub_type, rule.segment), // 32 HEV (Highend)
    odTpRates.netpoint,                                // 33 Netpoint (single rate when not OD/TP-specific)
    odTpRates.od,                                      // 34 OD Rate (when source said "X% on OD…")
    odTpRates.tp,                                      // 35 TP Rate (when source said "…Y% on TP")
    // Margin / Outgoing Rate — populated from the saved margin rule (if any)
    // that covers this rate row. Outgoing Rate uses Netpoint when present,
    // otherwise falls back to OD then TP, so a single value lands in the
    // column for every rate-bearing row.
    ...(() => {
      const mm = _findMarginForRule(rule);
      if (!mm || mm.margin_pct == null) return ['', ''];
      const baseRate = (odTpRates.netpoint != null && odTpRates.netpoint !== '')
        ? Number(odTpRates.netpoint)
        : (odTpRates.od != null && odTpRates.od !== '')
          ? Number(odTpRates.od)
          : (odTpRates.tp != null && odTpRates.tp !== '')
            ? Number(odTpRates.tp)
            : null;
      const marginPct = Number(mm.margin_pct);
      if (baseRate == null || isNaN(baseRate)) return [marginPct, ''];
      return [marginPct, Math.max(0, Number((baseRate - marginPct).toFixed(3)))];
    })(),
    appliedOn,                                         // 36 Applied on
    rule.sheet_name || '',                             // 37 SheetName (source sheet)
    rule.remarks || '',                                // 38 Remarks (verbatim UW text)
  ];
}

/**
 * Build a grouping key for merging CD1 (discount) with CD2 (rate) rows.
 * Two rules share a key if they come from the same insurer, sheet, region,
 * segment, make, model and have the same band values — i.e. they differ
 * only in rate_type.
 */
function ruleGroupKey(rule) {
  return [
    rule.rate_card_id,
    rule.insurer,
    rule.sheet_name,
    rule.region,
    rule.segment,
    rule.make,
    rule.model,
    rule.sub_type,
    rule.fuel_type,
    rule.vehicle_age_min,
    rule.vehicle_age_max,
    rule.weight_band_min,
    rule.weight_band_max,
    rule.cc_band_min,
    rule.cc_band_max,
    rule.seating_capacity_min,
    rule.seating_capacity_max,
    rule.volume_tier,
    rule.addon,
    rule.carrier_type,
    rateBodyGroup(rule.rate_type),  // discriminate body-type column groups
  ].map(v => (v == null ? '' : String(v))).join('||');
}

/**
 * Build a stable condition key from an expansion entry's overrides.
 * Used to match CD1 and CD2 conditional sub-entries that share the same condition.
 *
 * Examples:
 *   { _addon_flag: 'Yes' }                → "_addon:Yes"
 *   { vehicle_age_min: 0, vehicle_age_max: 2 } → "_age:0-2"
 *   { _make_condition: 'TATA' }            → "_make:TATA"
 *   { weight_band_min: 40, weight_band_max: 44 } → "_ton:40-44"
 *   { _region_condition: 'West Bengal' }   → "_region:West Bengal"
 *   { _ncb_condition: 'with NCB...' }     → "_ncb:with NCB..."
 */
function conditionKey(overrides) {
  if (!overrides) return '';
  if (overrides._addon_flag) return '_addon:' + overrides._addon_flag;
  if (overrides._make_condition) return '_make:' + overrides._make_condition;
  if (overrides._region_condition) return '_region:' + overrides._region_condition;
  if (overrides._ncb_condition) return '_ncb:' + (overrides._ncb_min ?? '') + '-' + (overrides._ncb_max ?? '');
  if (overrides.vehicle_age_min !== undefined) return '_age:' + overrides.vehicle_age_min + '-' + (overrides.vehicle_age_max ?? '');
  if (overrides.weight_band_min !== undefined) return '_ton:' + overrides.weight_band_min + '-' + (overrides.weight_band_max ?? '');
  if (overrides._discount !== undefined) return '_cd:' + overrides._discount;
  return '';
}

/**
 * Apply overrides from a conditional expansion entry onto a base rule,
 * returning a new (shallow-cloned) rule object.
 */
function applyOverrides(rule, entry) {
  const expandedRule = { ...rule };

  if (entry.overrides.vehicle_age_min !== undefined) {
    expandedRule.vehicle_age_min = entry.overrides.vehicle_age_min;
  }
  if (entry.overrides.vehicle_age_max !== undefined) {
    expandedRule.vehicle_age_max = entry.overrides.vehicle_age_max;
  }
  if (entry.overrides.weight_band_min !== undefined) {
    expandedRule.weight_band_min = entry.overrides.weight_band_min;
  }
  if (entry.overrides.weight_band_max !== undefined) {
    expandedRule.weight_band_max = entry.overrides.weight_band_max;
  }

  // Set rate value from parsed entry
  expandedRule.rate_value = entry.rate_value;
  expandedRule.is_declined = entry.is_declined;
  expandedRule.is_conditional = false;

  // Condition-specific fields
  if (entry.overrides._addon_condition) {
    expandedRule._addon_flag = entry.overrides._addon_flag || '';
  }
  if (entry.overrides._make_condition) {
    expandedRule.remarks = [rule.remarks, entry.overrides._make_condition].filter(Boolean).join(' | ');
  }
  if (entry.overrides._region_condition) {
    expandedRule.remarks = [rule.remarks, entry.overrides._region_condition].filter(Boolean).join(' | ');
  }
  if (entry.overrides._ncb_condition) {
    // Set NCB min/max from parsed values (overrides DB / inferNCB defaults)
    if (entry.overrides._ncb_min !== undefined) {
      expandedRule._ncb_override_min = entry.overrides._ncb_min;
      expandedRule._ncb_override_max = entry.overrides._ncb_max;
    }
    // Set break-in max days
    if (entry.overrides._break_in_max !== undefined) {
      expandedRule._break_in_max = entry.overrides._break_in_max;
    }
  }

  return expandedRule;
}

/**
 * Emit one or more rows for a rule, expanding multi-fuel segments into separate rows.
 * E.g. "GCV4 3.5 To 7.5T-Petrol/CNG" → two rows: one for Petrol, one for CNG.
 *
 * @param {Array} aoa - output array-of-arrays
 * @param {object} rule - the rule object
 * @param {number} srno - current serial number
 * @param {Map} rtoIndex - RTO lookup
 * @param {number|string} discount - discount value
 * @returns {number} updated srno
 */
function emitWithFuelExpansion(aoa, rule, srno, rtoIndex, discount) {
  const fuelTypes = parseFuelTypes(rule.fuel_type, rule.segment);

  // Both "NCB Cases" (NCB 1-99) and "Without NCB Cases" (NCB 0) emit a
  // companion row with NCB blank — so a policy whose NCB column is null /
  // missing still matches the rule. parseNcbFromText flags this via
  // `also_blank: true`; we emit each fuel-row TWICE when it's set.
  const ncbAux = [rule.sub_type, rule.segment, rule.remarks].filter(Boolean).join(' | ');
  const ncbHint = parseNcbFromText(ncbAux);
  // Fan out a blank-NCB companion when EITHER regex caught an NCB-related
  // sentinel OR the LLM extracted any ncb_min/ncb_max for this remark.
  const llmRow = _llmGet(rule.remarks);
  const llmHasNcb = !!(llmRow && (Number.isFinite(llmRow.ncb_min) || Number.isFinite(llmRow.ncb_max)));
  const fanOutBlankNcb = !!(ncbHint && ncbHint.also_blank) || llmHasNcb;

  const fuels = fuelTypes.length > 0 ? fuelTypes : [''];
  for (const ft of fuels) {
    aoa.push(ruleToRow(rule, srno++, rtoIndex, discount, ft));
    if (fanOutBlankNcb) {
      aoa.push(ruleToRow(rule, srno++, rtoIndex, discount, ft, { ncbBlank: true }));
    }
  }

  return srno;
}

// ---------- Public API ----------

/**
 * Build an .xlsx Buffer from one or more rate card IDs.
 *
 * Merges CD1 (discount) and CD2 (rate) rows that share the same key fields
 * into a single export row where discount appears in min/max discount columns
 * and the rate appears in Rate %.
 *
 * @param {number|number[]} rateCardIds
 * @returns {Promise<Buffer>}
 */
/**
 * Expand rules whose `region` cell encodes multiple clusters into one rule
 * per cluster. Two cases handled:
 *
 *   1. CSV / "&" list — "MP1,MP2,MP3", "MP1, MP2 & MP3"
 *      → emits one rule each for MP1 / MP2 / MP3.
 *
 *   2. Catch-all complement — "Other Than ROTN,Kerala,MP1,MP2 &MP3"
 *      → emits one rule for every distinct cluster in `rtos` that is NOT
 *        in the listed exclusion set. This is what restores rates for
 *        regions like UP3 that the source sheet only addresses via an
 *        "Other Than ..." row.
 */
function expandCompoundRegions(rules, rtos) {
  // Universe of clusters (= region values used elsewhere in the same insurer)
  const universeByInsurer = new Map();
  for (const r of rules) {
    if (!r || !r.insurer) continue;
    if (!universeByInsurer.has(r.insurer)) universeByInsurer.set(r.insurer, new Set());
    if (r.region && !/[,&]|other\s*than/i.test(r.region)) {
      universeByInsurer.get(r.insurer).add(r.region);
    }
  }
  // Augment with cluster names from rto_mappings (covers clusters that
  // only appear in mappings but not in rate_rules.region).
  for (const m of (rtos || [])) {
    if (m && m.insurer && (m.cluster || m.region)) {
      if (!universeByInsurer.has(m.insurer)) universeByInsurer.set(m.insurer, new Set());
      universeByInsurer.get(m.insurer).add(m.cluster || m.region);
    }
  }

  const splitList = (s) => String(s || '')
    .split(/\s*(?:,|&|\band\b)\s*/i)
    .map(x => x.trim())
    .filter(Boolean);

  const out = [];
  for (const r of rules) {
    const reg = String(r.region || '').trim();
    if (!reg) { out.push(r); continue; }

    // "Other Than X,Y,Z" → universe \ {X,Y,Z}
    const otherM = reg.match(/^Other\s+Than\s+(.+)$/i);
    if (otherM) {
      const exclude = new Set(splitList(otherM[1]).map(s => s.toLowerCase()));
      const uni = universeByInsurer.get(r.insurer) || new Set();
      let any = false;
      for (const cluster of uni) {
        if (exclude.has(String(cluster).toLowerCase())) continue;
        out.push({ ...r, region: cluster });
        any = true;
      }
      // Fallback: keep the original if the universe was empty so we don't
      // silently lose the rule.
      if (!any) out.push(r);
      continue;
    }

    // Plain CSV / & — only split when there are 2+ items AND the result
    // doesn't break atomic abbreviations. Specifically:
    //   - "J & K" / "J&K"           → ["J","K"]    (single char)  → KEEP atomic
    //   - "PB/CH/HP/J&K"            → ["PB/CH/HP/J","K"] (single)→ KEEP atomic
    //   - "TAMILNADU & PONDICHERRY" → maps to canonical state    → KEEP atomic
    //   - "MP1, MP2 & MP3"          → all have digits, multi-char → split
    if (/[,&]|\band\b/i.test(reg)) {
      const parts = splitList(reg);
      const hasSingleCharPart = parts.some(p => p.length <= 1);
      // Whole-region canonical match (e.g. "j & k" / "j&k" → Jammu & Kashmir)
      const wholeIsCanonicalState =
        typeof INDIAN_STATE_CANONICAL !== 'undefined' &&
        Object.prototype.hasOwnProperty.call(
          INDIAN_STATE_CANONICAL, reg.toLowerCase().replace(/\s+/g, ' ').trim());
      if (parts.length >= 2 && !hasSingleCharPart && !wholeIsCanonicalState) {
        for (const p of parts) out.push({ ...r, region: p });
        continue;
      }
    }

    out.push(r);
  }
  return out;
}

/**
 * Fan out rules whose Section Text is "All" into 3 rows (Comp / SAOD / TP).
 * The parser preserves the original "All" inside rate_type so this expansion
 * can detect it. Both encodings are handled:
 *   - pivot_by_city: "DM|All|Slab 1|NCB:Yes" → "DM|Package|...", "DM|SAOD|...",
 *                                              "DM|SATP|..."
 *   - flat_table:    "All_OD" / "All_TP"      → "Package_OD" / "SAOD_OD" /
 *                                              "SATP_OD" (and same for TP)
 */
function expandAllSection(rules) {
  // Each variant: the text we substitute for "All" in rate_type, plus the
  // user-facing product (so the export's inferProduct picks it up).
  // Comp ← Package, SAOD ← SAOD, TP ← SATP.
  const VARIANTS = ['Package', 'SAOD', 'SATP'];

  const out = [];
  for (const r of rules) {
    const rt = String(r.rate_type || '');
    // Match "|All|" or "|All$" or "^All|" (pivot encoding)
    if (/(^|\|)All(\||$)/i.test(rt)) {
      for (const v of VARIANTS) {
        out.push({ ...r, rate_type: rt.replace(/(^|\|)All(\||$)/i, `$1${v}$2`) });
      }
      continue;
    }
    // Match "All_<rest>" or "<prefix>_All_<rest>" or "_All$" (flat encoding)
    if (/(^|_)All(_|$)/i.test(rt)) {
      for (const v of VARIANTS) {
        out.push({ ...r, rate_type: rt.replace(/(^|_)All(_|$)/i, `$1${v}$2`) });
      }
      continue;
    }
    out.push(r);
  }
  return out;
}

/**
 * Merge OD/TP rule pairs into a single virtual rule.
 *
 * Royal 2w Comp Bike, IRDA fan-outs, and TATA ROBINHOOD Pvt Pkg all
 * emit two DB rules per source cell — one tagged as the OD half, one
 * as the TP half — sharing the same context. For the Excel export we
 * want ONE row per pair with both `OD Rate` and `TP Rate` populated.
 *
 * Detection (per rule):
 *   - tagged OD if applied_on='OD' OR rate_type contains "_OD" /
 *     "|OD" / "IRDA_OD"
 *   - tagged TP if applied_on='TP' OR rate_type contains "_TP" /
 *     "|TP" / "IRDA_TP"  (SATP is explicitly excluded — it's a
 *     section-text marker, not a TP-half tag)
 *   - pair key = same insurer/sheet/region/segment/make/sub_type/
 *     fuel/bands/addon/volume_tier, with the OD/TP suffix stripped
 *     from rate_type
 *
 * When both halves are present, emit a single merged rule carrying
 * `_od_rate` and `_tp_rate` so the row builder can render both in the
 * dedicated columns. Singletons (only OD found, or only TP) pass
 * through unchanged so their lone rate still lands somewhere.
 */
function mergeOdTpPairs(rules) {
  const detect = (rt, ao) => {
    const RT = String(rt || '').toUpperCase();
    const AO = String(ao || '').toUpperCase();
    // Section-name SATP must NOT be treated as a TP-half tag.
    const odTag = AO === 'OD' || /(?:^|[_|])OD(?:[_|]|$)/.test(RT) || /IRDA_OD/.test(RT);
    const tpTag = (AO === 'TP' || /(?:^|[_|])TP(?:[_|]|$)/.test(RT) || /IRDA_TP/.test(RT))
      && !RT.includes('SATP');
    if (odTag) return 'OD';
    if (tpTag) return 'TP';
    return null;
  };
  const stripOdTpSuffix = (rt) => String(rt || '').replace(
    /(?:_NilDep|_NoNilDep)?(?:_)?(?:IRDA_)?(?:OD|TP)(?:_NilDep|_NoNilDep)?$/i, ''
  ).replace(/_+$/, '');

  const pairKey = (r) => [
    (r.insurer || '').toLowerCase(),
    (r.sheet_name || '').toLowerCase(),
    (r.region || '').toLowerCase(),
    (r.segment || '').toLowerCase(),
    (r.make || '').toLowerCase(),
    (r.model || '').toLowerCase(),
    (r.sub_type || '').toLowerCase(),
    (r.fuel_type || '').toLowerCase(),
    (r.addon || '').toLowerCase(),
    (r.volume_tier || '').toLowerCase(),
    r.cc_band_min, r.cc_band_max,
    r.weight_band_min, r.weight_band_max,
    r.vehicle_age_min, r.vehicle_age_max,
    r.seating_capacity_min, r.seating_capacity_max,
    stripOdTpSuffix(r.rate_type).toUpperCase(),
  ].join('||');

  const odByKey = new Map();
  const tpByKey = new Map();
  for (const r of rules) {
    const tag = detect(r.rate_type, r.applied_on);
    if (!tag) continue;
    const key = pairKey(r);
    if (tag === 'OD' && !odByKey.has(key)) odByKey.set(key, r);
    if (tag === 'TP' && !tpByKey.has(key)) tpByKey.set(key, r);
  }

  // Only dedup on the merge path. Singleton OD/TP rules sharing the same
  // pairKey but differing in rate_value/remarks (e.g. AP Pvt Car: Diesel
  // rate=15 "IDV UPTO 10 LACS" vs Diesel rate=10) must each emit their
  // own row — they're not OD+TP halves of one source cell.
  const mergedKeys = new Set();
  const out = [];
  for (const r of rules) {
    const tag = detect(r.rate_type, r.applied_on);
    if (!tag) { out.push(r); continue; }
    const key = pairKey(r);
    const od = odByKey.get(key);
    const tp = tpByKey.get(key);
    if (od && tp) {
      if (mergedKeys.has(key)) continue;
      mergedKeys.add(key);
      out.push({
        ...od,
        _od_rate: od.rate_value,
        _tp_rate: tp.rate_value,
        _od_tp_pair: true,
        rate_type: stripOdTpSuffix(od.rate_type),
      });
    } else {
      out.push(r);
    }
  }
  return out;
}

async function buildExportBuffer(rateCardIds, options = {}) {
  const { rules: rawRules, rtos } = await fetchRulesAndRtos(rateCardIds);
  const expandedSections = expandAllSection(rawRules);
  const merged = mergeOdTpPairs(expandedSections);
  const rules = expandCompoundRegions(merged, rtos);
  // Load active saved margins so the export can populate the Margin /
  // Outgoing Rate columns per row. Failures here are non-fatal — we just
  // emit blanks in those columns.
  let activeMargins = [];
  let llmExtracts = new Map();
  try {
    const pool = await getPool();
    const mrReq = pool.request(); mrReq.timeout = 600000;
    const mr = await mrReq.query(
      `SELECT id, margin_pct, filters_json FROM margin_rules WHERE active = 1`
    );
    activeMargins = mr.recordset.map(row => {
      let filters = {};
      try { filters = JSON.parse(row.filters_json || '{}') || {}; } catch { /* keep empty */ }
      // margin_pct is a SQL DECIMAL — Number() handles both string and number returns.
      const pct = row.margin_pct != null ? Number(row.margin_pct) : null;
      return { id: row.id, margin_pct: pct, filters };
    });
    // Load LLM extracts so the inference helpers (NCB / CPA / IDV /
    // BusinessType / Zone) can prefer LLM values over regex when the
    // regex misses ("with out NCB" / "with-out NCB" / typos / multi-line).
    try {
      const crReq = pool.request(); crReq.timeout = 600000;
      const cr = await crReq.query(
        `SELECT remark_text, json_extract FROM parsed_remarks_cache WHERE LEN(json_extract) > 2`
      );
      for (const row of cr.recordset) {
        try {
          const parsed = JSON.parse(row.json_extract);
          if (parsed && typeof parsed === 'object') llmExtracts.set(row.remark_text, parsed);
        } catch { /* skip bad JSON */ }
      }
    } catch (e) {
      console.warn('[export] failed to load LLM extracts:', e.message);
    }
  } catch (e) {
    console.warn('[export] failed to load saved margins:', e.message);
  }
  let filtered = rules;
  if (options.product) {
    // Match against the rule's product column. Accept common aliases so
    // callers can pass "Pvt car" or "Private Car" → CAR / 4W.
    const target = String(options.product).trim().toUpperCase();
    const aliases = {
      'PVT CAR': ['CAR', '4W', 'PC', 'PVT CAR', 'PVT_CAR', 'PRIVATE CAR'],
      'PVT_CAR': ['CAR', '4W', 'PC', 'PVT CAR', 'PVT_CAR', 'PRIVATE CAR'],
      'PRIVATE CAR': ['CAR', '4W', 'PC', 'PRIVATE CAR'],
      'CAR': ['CAR', '4W', 'PC', 'PVT CAR', 'PRIVATE CAR'],
      '4W':  ['CAR', '4W', 'PC'],
      'TW':  ['TW', '2W'],
      '2W':  ['TW', '2W'],
      'GCV': ['GCV'],
      'PCV': ['PCV', 'BUS', 'TAXI'],
      'CV':  ['CV', 'GCV', 'PCV'],
      'MISC': ['MISC', 'MIS'],
    };
    const accept = new Set((aliases[target] || [target]).map(s => s.toUpperCase()));
    filtered = rules.filter(r => accept.has(String(r.product || '').toUpperCase()));
  }
  return buildExportBufferFromData(filtered, rtos, { margins: activeMargins, llmExtracts });
}

/**
 * Same as buildExportBuffer but takes parsed rules + rto mappings in memory —
 * lets callers generate an xlsx without going through the database.
 */
function buildExportBufferFromData(rules, rtos, opts = {}) {
  const rtoIndex = buildRtoIndex(rtos || []);
  // Stash the active margins for the duration of this build so ruleToRow()
  // can do per-row coverage lookups without us having to thread the list
  // through every emit call site.
  _activeMarginsForExport = Array.isArray(opts.margins) ? opts.margins : [];
  _llmExtractByRemark = opts.llmExtracts instanceof Map ? opts.llmExtracts : new Map();

  // ── Step 1: Build CD1 discount maps ──
  // cd1Map: groupKey → scalar discount (non-conditional CD1 rows)
  const cd1Map = new Map();
  // cd1ConditionalMap: groupKey → Map<conditionLabel, {discount, overrides}>
  //   For conditional CD1 rows like "With Addon: 85%\nWithout Addon: 60%"
  //   each parsed sub-entry is keyed by its condition label (e.g. "_addon:Yes")
  const cd1ConditionalMap = new Map();

  for (const rule of rules) {
    if (!isDiscountRate(rule.rate_type)) continue;
    const key = ruleGroupKey(rule);

    if (rule.rate_value != null && !rule.is_declined) {
      cd1Map.set(key, Number(rule.rate_value));
    }

    // Pre-expand conditional CD1 text into the conditional map
    if (rule.is_conditional && rule.rate_text) {
      const expanded = parseConditionalRateText(rule.rate_text);
      if (expanded.length > 0) {
        let subMap = cd1ConditionalMap.get(key);
        if (!subMap) { subMap = new Map(); cd1ConditionalMap.set(key, subMap); }
        for (const entry of expanded) {
          const condKey = conditionKey(entry.overrides);
          subMap.set(condKey, {
            discount: (entry.rate_value != null && !entry.is_declined) ? entry.rate_value : '',
            overrides: entry.overrides,
          });
        }
      }
    }
  }

  // ── Step 2: Build export rows ──
  const aoa = [HEADERS];
  let srno = 1;

  // Track which CD1 keys have been merged into a CD2 row
  const mergedCD1Keys = new Set();
  const mergedCD1CondKeys = new Set(); // "groupKey||condKey" for conditional merges

  // First pass: emit non-CD1 rows with their matching discount
  for (const rule of rules) {
    if (isDiscountRate(rule.rate_type)) continue; // skip CD1 rows for now

    const key = ruleGroupKey(rule);
    const scalarDiscount = cd1Map.get(key) ?? '';
    const cd1Cond = cd1ConditionalMap.get(key); // conditional CD1 sub-map for this group

    if (scalarDiscount !== '') {
      mergedCD1Keys.add(key);
    }

    // Expand conditional rate text into multiple rows
    if (rule.is_conditional && rule.rate_text) {
      const expanded = parseConditionalRateText(rule.rate_text);
      if (expanded.length > 0) {
        for (const entry of expanded) {
          const expandedRule = applyOverrides(rule, entry);

          // Look up matching conditional CD1 discount for this sub-entry
          const cKey = conditionKey(entry.overrides);
          let rowDiscount = entry.overrides._discount ?? scalarDiscount;

          if (cd1Cond && cd1Cond.has(cKey)) {
            rowDiscount = cd1Cond.get(cKey).discount;
            mergedCD1CondKeys.add(key + '||' + cKey);
          }

          srno = emitWithFuelExpansion(aoa, expandedRule, srno, rtoIndex, rowDiscount);
        }

        // Mark conditional CD1 as merged if ALL its sub-entries matched
        if (cd1Cond) mergedCD1Keys.add(key);

        continue; // skip the original conditional row
      }
    }

    // If this CD2 row is NOT conditional but has a matching conditional CD1,
    // fan out one row per CD1 condition (e.g. "with NCB: 85%, without NCB: 75%"
    // paired with a scalar CD2 rate → 2 rows, each with the right discount + NCB + break-in)
    if (cd1Cond && cd1Cond.size > 0) {
      mergedCD1Keys.add(key);
      for (const [cKey, cd1Entry] of cd1Cond) {
        const expandedRule = applyOverrides(rule, { overrides: cd1Entry.overrides, rate_value: rule.rate_value, is_declined: rule.is_declined });
        // Keep the original CD2 rate_value (not the CD1 discount)
        expandedRule.rate_value = rule.rate_value;
        expandedRule.is_declined = rule.is_declined;
        mergedCD1CondKeys.add(key + '||' + cKey);
        srno = emitWithFuelExpansion(aoa, expandedRule, srno, rtoIndex, cd1Entry.discount);
      }
      continue;
    }

    srno = emitWithFuelExpansion(aoa, rule, srno, rtoIndex, scalarDiscount);
  }

  // Second pass: emit unmerged CD1 rows (CD1 with no matching CD2)
  for (const rule of rules) {
    if (!isDiscountRate(rule.rate_type)) continue;

    const key = ruleGroupKey(rule);
    if (mergedCD1Keys.has(key)) continue; // fully merged

    // Expand conditional CD1 rows — emit only un-merged sub-entries
    if (rule.is_conditional && rule.rate_text) {
      const expanded = parseConditionalRateText(rule.rate_text);
      if (expanded.length > 0) {
        for (const entry of expanded) {
          const cKey = conditionKey(entry.overrides);
          if (mergedCD1CondKeys.has(key + '||' + cKey)) continue; // this sub-entry was merged

          const expandedRule = applyOverrides(rule, entry);
          const discountVal = (entry.rate_value != null && !entry.is_declined)
            ? entry.rate_value : '';
          srno = emitWithFuelExpansion(aoa, expandedRule, srno, rtoIndex, discountVal);
        }
        continue;
      }
    }

    // Standalone scalar CD1
    const discountVal = (rule.rate_value != null && !rule.is_declined)
      ? Number(rule.rate_value) : '';
    srno = emitWithFuelExpansion(aoa, rule, srno, rtoIndex, discountVal);
  }

  // Dedupe: the parser emits one rule per rate_type (e.g. 6 SAOD bands per
  // region); when the row content — excluding Srno, Margin, Outgoing Rate
  // — is identical across those rules (typical for declined regions where
  // rate is blank, or property/non-motor sub-types that share the same
  // payout), the export produces visually identical rows. Collapse them to
  // one and renumber Srno.
  //
  // When two source rows would dedup but only one carries a margin value
  // (because some source rate_rules were covered by a saved margin and
  // others weren't), we keep the populated margin so the merged row in
  // the .xlsx never silently drops a covered margin.
  const header = aoa[0];
  const MARGIN_COL   = HEADERS.indexOf('Margin');
  const OUTGOING_COL = HEADERS.indexOf('Outgoing Rate');
  const seen = new Map();   // dedup-key → index into `deduped`
  const deduped = [header];
  for (let i = 1; i < aoa.length; i++) {
    const row = aoa[i];
    // key = every column EXCEPT Srno (0) AND Margin/Outgoing Rate, so two
    // rows that are otherwise identical but only differ in margin coverage
    // collapse into one.
    const key = row.map((c, idx) =>
      (idx === 0 || idx === MARGIN_COL || idx === OUTGOING_COL)
        ? '' : String(c ?? '')
    ).join('');
    if (seen.has(key)) {
      // Promote the first non-empty Margin / Outgoing Rate from the
      // duplicates onto the kept row so a covered margin is never lost
      // when source rate_rules dedup against an uncovered 'first' row.
      const kept = deduped[seen.get(key)];
      if (MARGIN_COL >= 0) {
        const keptHas = kept[MARGIN_COL] !== '' && kept[MARGIN_COL] != null;
        const newHas  = row[MARGIN_COL]  !== '' && row[MARGIN_COL]  != null;
        if (!keptHas && newHas) {
          kept[MARGIN_COL]   = row[MARGIN_COL];
          kept[OUTGOING_COL] = row[OUTGOING_COL];
        }
      }
      continue;
    }
    seen.set(key, deduped.length);
    row[0] = deduped.length; // renumber Srno
    deduped.push(row);
  }

  const ws = XLSX.utils.aoa_to_sheet(deduped);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/**
 * Export-side NOP extractor. Accepts either the parser-normalized form
 * ("NOP 100-500" / "NOP upto 30" / "NOP 500+") OR the raw Excel value
 * ("NEW(100-500 NOP)" / "NEW(UPTO 30 NOP)"). Returns {min, max} with
 * null when unknown. ANNUAL / ACT / empty → {min: null, max: null}.
 */
function parseNopForExport(volumeTier, subType) {
  const src = [volumeTier, subType].map(v => String(v || '')).join(' ').toUpperCase();
  if (!/NOP/.test(src)) return { min: null, max: null };
  // "UPTO N NOP" / "UP TO N NOP"
  let m = src.match(/(?:UP\s*TO|UPTO|<=?)\s*(\d+)\s*NOP/);
  if (m) return { min: null, max: parseInt(m[1], 10) };
  // "A-B NOP"
  m = src.match(/(\d+)\s*(?:-|TO|–)\s*(\d+)\s*NOP/);
  if (m) return { min: parseInt(m[1], 10), max: parseInt(m[2], 10) };
  // "N+ NOP" / ">= N NOP" / "> N NOP" / "ABOVE N NOP"
  m = src.match(/(?:>=?|ABOVE)\s*(\d+)\s*NOP/);
  if (m) return { min: parseInt(m[1], 10), max: null };
  m = src.match(/(\d+)\s*\+\s*NOP/);
  if (m) return { min: parseInt(m[1], 10), max: null };
  // Single value: "N NOP"
  m = src.match(/(\d+)\s*NOP/);
  if (m) return { min: parseInt(m[1], 10), max: parseInt(m[1], 10) };
  return { min: null, max: null };
}

module.exports = {
  buildExportBuffer,
  buildExportBufferFromData,
  // exported for unit testing
  HEADERS,
  normalizeInsurer,
  inferVehicleType,
  inferVehicleCategory,
  inferProduct,
  inferAppliedOn,
  inferNCB,
  inferHEV,
  isDiscountRate,
  parseTonnageFromSegment,
  parseAgeFromSegment,
  parseConditionalRateText,
  parseFuelTypes,
  normalizePercent,
  // pipeline helpers (test-only export)
  mergeOdTpPairs,
};
