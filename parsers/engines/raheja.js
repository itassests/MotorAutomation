/**
 * Raheja QBE General Insurance — Motor commission engine.
 *
 * Source: monthly grid email (.msg file) from the Raheja team. The rates
 * change each month so we parse the email body dynamically rather than
 * hard-coding them.
 *
 * Email layout (Apr'26 reference):
 *   - Zone → States map (5 zones: North/Centre/East/West/South + Mumbai)
 *   - GCV grid:  weight-band × zone (Comp + TP per cell)
 *   - PCV grid:  Auto Rickshaw / Kali Peeli × zone
 *   - MISD grid: Agri Tractor × zone
 *   - Pvt Car grid:  zone × (New, Comp Old NCB-tiered, SAOD Old NCB-tiered, SATP)
 *
 * Each cell is in the form "Comp-X% & TP-Y%" → emit one COMP rule
 * (applied_on='NET', rate=X) and one SATP rule (applied_on='TP', rate=Y).
 *
 * "NA" cells → declined rules (rate=0, is_declined=true).
 *
 * Entry: parseMsgFile(filePath) → rule[]
 */

const CFB = require('cfb');
const fs = require('fs');
const path = require('path');

// ----------------------------------------------------------------------------
// MSG reader — extract the plain-text email body via Compound File Binary.
// ----------------------------------------------------------------------------
function readMsgBody(filePath) {
  const buf = fs.readFileSync(filePath);
  const cfb = CFB.read(buf, { type: 'buffer' });
  const body = cfb.FileIndex.find(f =>
    f.name && /1000001F$/i.test(f.name)        // PR_BODY (Unicode)
  );
  if (!body) return '';
  return Buffer.from(body.content).toString('utf16le');
}

// ----------------------------------------------------------------------------
// Parse the Zone → States map block. Returns { ZoneName: [stateCode, ...] }.
// Body fragment (each line on its own row in cfb output):
//   "Zone/States" / "States" / "Note"
//   "North"
//   "JK,HP,UK,PB,CH,HR,DL,UP,CG"
//   ... (per-zone pairs)
// ----------------------------------------------------------------------------
const STATE_CODE_TO_NAME = {
  JK: 'Jammu & Kashmir', HP: 'Himachal Pradesh', UK: 'Uttarakhand',
  PB: 'Punjab', CH: 'Chandigarh', HR: 'Haryana', DL: 'Delhi',
  UP: 'Uttar Pradesh', CG: 'Chhattisgarh',
  RJ: 'Rajasthan', MP: 'Madhya Pradesh',
  WB: 'West Bengal', BR: 'Bihar', OR: 'Odisha', JH: 'Jharkhand',
  MH: 'Maharashtra', GJ: 'Gujarat', GA: 'Goa',
  DD: 'Daman & Diu', DN: 'Dadra & Nagar Haveli',
  AP: 'Andhra Pradesh', TS: 'Telangana', TN: 'Tamil Nadu',
  KA: 'Karnataka', PY: 'Puducherry', KL: 'Kerala',
};

function parseZoneMap(body) {
  // Look for the "Zone/States" header block; the lines that follow have
  // alternating zone-name / state-code-list pairs.
  const lines = body.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = {};
  for (let i = 0; i < lines.length - 1; i++) {
    const zone = lines[i];
    const next = lines[i + 1];
    if (/^(North|Centre|East|West|South)$/i.test(zone) &&
        /^[A-Z]{2}\s*(,\s*[A-Z]{2}\s*)+$/.test(next.replace(/\s+/g, ' '))) {
      const codes = next.split(',').map(c => c.trim().toUpperCase());
      out[zone] = codes.map(c => STATE_CODE_TO_NAME[c] || c);
    }
  }
  return out;
}

// ----------------------------------------------------------------------------
// Cell parsing — "Comp-50% & TP-55%", "NA", "Only TN Reg.-25%", "35%" etc.
// ----------------------------------------------------------------------------
function parseCompTpCell(s) {
  const t = String(s || '').trim();
  if (!t || /^NA$/i.test(t)) return { kind: 'na' };
  const m = t.match(/Comp[- ]*(\d+(?:\.\d+)?)\s*%.*?TP[- ]*(\d+(?:\.\d+)?)\s*%/i);
  if (m) return { kind: 'comp_tp', comp: parseFloat(m[1]) / 100, tp: parseFloat(m[2]) / 100 };
  // "Only TN Reg.-25%" or any single percentage
  const single = t.match(/(\d+(?:\.\d+)?)\s*%/);
  if (single) return { kind: 'single', rate: parseFloat(single[1]) / 100, raw: t };
  return { kind: 'unknown', raw: t };
}

// Single-percentage cell like "35%" / "27%"
function parsePctCell(s) {
  const m = String(s || '').match(/(\d+(?:\.\d+)?)\s*%/);
  return m ? parseFloat(m[1]) / 100 : null;
}

// ----------------------------------------------------------------------------
// Emit helpers
// ----------------------------------------------------------------------------
function emitCompTp(rules, meta, baseCommon, cell, zone, states) {
  const cellInfo = parseCompTpCell(cell);
  for (const state of states) {
    const baseRule = {
      ...baseCommon,
      sheet_name: meta.sheetName,
      state, region: state,
    };
    if (cellInfo.kind === 'na') {
      // Emit two declined rules so Comp + SATP halves are both visible
      rules.push({
        ...baseRule, rate_type: 'COMP', applied_on: 'NET',
        rate_value: 0, is_declined: true,
        remarks: `${baseCommon.segment} | ${zone}/${state} | NA (declined) | ${meta.gridMonth}`,
        rate_text: `Raheja ${baseCommon.segment} | ${zone}/${state} | NA`,
      });
      rules.push({
        ...baseRule, rate_type: 'SATP', applied_on: 'TP',
        rate_value: 0, is_declined: true,
        remarks: `${baseCommon.segment} | ${zone}/${state} | NA (declined) | ${meta.gridMonth}`,
        rate_text: `Raheja ${baseCommon.segment} | ${zone}/${state} | NA`,
      });
    } else if (cellInfo.kind === 'comp_tp') {
      rules.push({
        ...baseRule, rate_type: 'COMP', applied_on: 'NET',
        rate_value: cellInfo.comp, is_declined: false,
        remarks: `${baseCommon.segment} | ${zone}/${state} | Comp ${(cellInfo.comp*100).toFixed(2)}% on Net | ${meta.gridMonth}`,
        rate_text: `Raheja ${baseCommon.segment} | ${zone}/${state} Comp | ${(cellInfo.comp*100).toFixed(2)}%`,
      });
      rules.push({
        ...baseRule, rate_type: 'SATP', applied_on: 'TP',
        rate_value: cellInfo.tp, is_declined: false,
        remarks: `${baseCommon.segment} | ${zone}/${state} | SATP ${(cellInfo.tp*100).toFixed(2)}% on TP | ${meta.gridMonth}`,
        rate_text: `Raheja ${baseCommon.segment} | ${zone}/${state} SATP | ${(cellInfo.tp*100).toFixed(2)}%`,
      });
    } else if (cellInfo.kind === 'single') {
      // E.g. "Only TN Reg.-25%" — emit as a TP-only declined-except rule
      rules.push({
        ...baseRule, rate_type: 'SATP', applied_on: 'TP',
        rate_value: cellInfo.rate, is_declined: false,
        remarks: `${baseCommon.segment} | ${zone}/${state} | ${cellInfo.raw} | ${meta.gridMonth}`,
        rate_text: `Raheja ${baseCommon.segment} | ${zone}/${state} | ${cellInfo.raw}`,
      });
    }
  }
}

// ----------------------------------------------------------------------------
// Section parsers — each consumes a fragment of the body text
//   GCV / PCV / MISD blocks share the layout:
//     header: "Segment | Type | North | Centre | West | South | East"
//     each row: type (e.g. "0 to 2.5 GVW") followed by 5 cells
// ----------------------------------------------------------------------------
const ZONES = ['North', 'Centre', 'West', 'South', 'East'];

// Walk the body line-by-line and extract data rows. We look for known
// segment-type tokens (e.g. "0 to 2.5 GVW") then take the next 5 cells.
const GCV_TYPES = [
  { match: /^0\s*to\s*2\.5\s*GVW$/i,  segment: 'GCV ≤2.5T', weight_min: 0,   weight_max: 2.5 },
  { match: /^2\.5\s*to\s*3\.5\s*GVW$/i, segment: 'GCV 2.5-3.5T', weight_min: 2.5, weight_max: 3.5 },
  { match: /^3\.5\s*to\s*7\.5\s*GVW$/i, segment: 'GCV 3.5-7.5T', weight_min: 3.5, weight_max: 7.5 },
  { match: /^Flat\s*Bed$/i,           segment: 'GCV Flat Bed' },
];

// Auto Rickshaw / Kali Peeli row → emit TWO distinct rules per cell so the
// VehicleCategory column shows each subtype on its own row.
const PCV_TYPES = [
  { match: /Auto\s*Rikshaw|Auto\s*Rickshaw|Kali\s*Peeli/i,
    segments: ['Auto Rickshaw', 'Kali Peeli'] },
];

const MISD_TYPES = [
  { match: /Agri\s*Tractor/i, segment: 'Agri Tractor' },
];

function emitGridSection(rules, meta, lines, typeDefs, productKey, zoneMap) {
  for (let i = 0; i < lines.length; i++) {
    const matchedType = typeDefs.find(t => t.match.test(lines[i]));
    if (!matchedType) continue;
    // Take next 5 cells (one per zone, in N/C/W/S/E order)
    const cells = lines.slice(i + 1, i + 6);
    if (cells.length < 5) continue;
    // A type may declare either a single `segment` or a `segments` array.
    // When `segments` is present, emit one rule set per segment label
    // (e.g. "Auto Rickshaw" + "Kali Peeli" both at the same rate).
    const segLabels = matchedType.segments || [matchedType.segment];
    for (const segLabel of segLabels) {
      for (let z = 0; z < ZONES.length; z++) {
        const zone = ZONES[z];
        const states = zoneMap[zone] || [];
        if (states.length === 0) continue;
        const baseCommon = {
          product: productKey,
          segment: segLabel,
          make: 'All',
          weight_band_min: matchedType.weight_min ?? null,
          weight_band_max: matchedType.weight_max ?? null,
        };
        emitCompTp(rules, meta, baseCommon, cells[z], zone, states);
      }
    }
    i += 5;   // skip cells we just consumed
  }
}

// ----------------------------------------------------------------------------
// Pvt Car section — different shape: zone-rows with 4 columns (New, Comp Old
// tiered, SAOD Old tiered, SATP). Plus Mumbai surroundings as a 6th zone.
// ----------------------------------------------------------------------------
const PVT_CAR_ZONES = [
  'North', 'Centre', 'West', 'South', 'East', 'Mumbai and Surroundings',
];

function emitPvtCarSection(rules, meta, lines, zoneMap) {
  for (let i = 0; i < lines.length; i++) {
    const zoneName = PVT_CAR_ZONES.find(z => lines[i].toLowerCase() === z.toLowerCase() ||
                                           (z === 'Mumbai and Surroundings' && /^Mumbai/i.test(lines[i])));
    if (!zoneName) continue;
    // Take next 4 cells (New, Comp Old, SAOD Old, SATP)
    const cells = lines.slice(i + 1, i + 5);
    if (cells.length < 4) continue;
    // States for this zone — Mumbai treated as MH city
    const states = zoneName === 'Mumbai and Surroundings'
      ? ['Maharashtra']
      : (zoneMap[zoneName] || []);
    const isMumbai = zoneName === 'Mumbai and Surroundings';
    if (states.length === 0) continue;

    const newRate    = parsePctCell(cells[0]);             // e.g. 35%
    const compOldRaw = cells[1];                            // "NCB 25%... 32%/28%/19.5%"
    const saodOldRaw = cells[2];                            // "NCB-19.5% & Non NCB-15%"
    const satpRate   = parsePctCell(cells[3]);             // 27% / 35%

    for (const state of states) {
      const baseRule = {
        product: 'CAR',
        sheet_name: meta.sheetName,
        segment: 'Pvt Car',
        make: 'All',
        state,
        region: isMumbai ? 'Mumbai' : state,
        is_declined: false,
      };
      // New vehicle (age 0) — single rate, applied_on=NET
      if (newRate != null) {
        rules.push({
          ...baseRule, rate_type: 'COMP_1+3',
          vehicle_age_min: 0, vehicle_age_max: 0,
          applied_on: 'NET', rate_value: newRate,
          remarks: `Pvt Car New (1+3) | ${zoneName}/${state} | ${(newRate*100).toFixed(2)}% | ${meta.gridMonth}`,
          rate_text: `Raheja Pvt Car New | ${zoneName}/${state} | ${(newRate*100).toFixed(2)}%`,
        });
      }
      // Comp Old NCB-tiered — parse 3 tiers from the cell.
      // Min/Max NCB columns are populated by the export's parseNcbFromText
      // reading the "NCB GT 25%" / "NCB 20-24%" / "NCB = 0%" markers we
      // embed in remarks (no volume_tier here — that maps to Discount).
      const compTiers = parseNcbTiers(compOldRaw);
      for (const t of compTiers) {
        rules.push({
          ...baseRule, rate_type: 'COMP',
          vehicle_age_min: 1, vehicle_age_max: 99,
          sub_type: t.tag,
          age_band_min: t.ncb_min,           // DB column repurposed for NCB
          age_band_max: t.ncb_max,
          applied_on: 'NET', rate_value: t.rate,
          remarks: `Pvt Car Comp Old | ${zoneName}/${state} | ${t.ncb_marker} → ${(t.rate*100).toFixed(2)}% | ${meta.gridMonth}`,
          rate_text: `Raheja Pvt Car Comp Old | ${zoneName}/${state} ${t.tag} | ${(t.rate*100).toFixed(2)}%`,
        });
      }
      // SAOD Old NCB-tiered — "NCB-19.5% & Non NCB-15%"
      const saodTiers = parseNcbTiers(saodOldRaw);
      for (const t of saodTiers) {
        rules.push({
          ...baseRule, rate_type: 'SAOD',
          vehicle_age_min: 1, vehicle_age_max: 99,
          sub_type: t.tag,
          age_band_min: t.ncb_min,
          age_band_max: t.ncb_max,
          applied_on: 'OD', rate_value: t.rate,
          remarks: `Pvt Car SAOD Old | ${zoneName}/${state} | ${t.ncb_marker} → ${(t.rate*100).toFixed(2)}% | ${meta.gridMonth}`,
          rate_text: `Raheja Pvt Car SAOD Old | ${zoneName}/${state} ${t.tag} | ${(t.rate*100).toFixed(2)}%`,
        });
      }
      // SATP — single rate
      if (satpRate != null) {
        rules.push({
          ...baseRule, rate_type: 'SATP',
          applied_on: 'TP', rate_value: satpRate,
          remarks: `Pvt Car SATP | ${zoneName}/${state} | ${(satpRate*100).toFixed(2)}% | ${meta.gridMonth}`,
          rate_text: `Raheja Pvt Car SATP | ${zoneName}/${state} | ${(satpRate*100).toFixed(2)}%`,
        });
      }
    }
    i += 4;
  }
}

// Extract NCB tiers from a cell like:
//   "NCB 25% & Above-32% PO, NCB 20%-PO 28% & Non NCB- 19.5%"
//   "NCB-19.5% & Non NCB-15%"
//
// Each tier carries:
//   - sub_type   (label for Sub Modal column)
//   - volume_tier (numeric range for Min/Max Discount columns)
//   - rate
//
// Semantics:
//   "NCB 25% & Above" → min=25, max=99 (any NCB ≥ 25)
//   "NCB 20%"         → min=20, max=24 (the specific 20-24% NCB band)
//   "Non NCB"         → min=0,  max=0   (NCB=0)
//   "NCB" (bare)      → min=1,  max=99 (any positive NCB)
function parseNcbTiers(text) {
  const s = String(text || '');
  const tiers = [];

  // "NCB 25% & Above-32%" → ≥25% → 32% PO
  let m = s.match(/NCB\s*(\d+)\s*%\s*&\s*Above[\s-]*(\d+(?:\.\d+)?)\s*%/i);
  if (m) {
    const n = parseInt(m[1], 10);
    tiers.push({
      tag: `NCB≥${n}%`,
      ncb_min: n, ncb_max: 99,
      ncb_marker: `NCB ${n}-99%`,      // parseNcbFromText reads this
      rate: parseFloat(m[2]) / 100,
    });
  }
  // "NCB 20%-PO 28%" → NCB exactly in next-lower band (20-24%) → 28% PO.
  const aboveMatch = s.match(/NCB\s*(\d+)\s*%\s*&\s*Above/i);
  const nextThreshold = aboveMatch ? parseInt(aboveMatch[1], 10) - 1 : 24;
  m = s.match(/NCB\s*(\d+)\s*%[\s-]*PO\s*(\d+(?:\.\d+)?)\s*%/i);
  if (m) {
    const n = parseInt(m[1], 10);
    tiers.push({
      tag: `NCB=${n}%`,
      ncb_min: n, ncb_max: nextThreshold,
      ncb_marker: `NCB ${n}-${nextThreshold}%`,
      rate: parseFloat(m[2]) / 100,
    });
  }
  // Generic bare "NCB <num>%" (no "& Above", no "PO" qualifier) → any positive NCB.
  if (tiers.length === 0) {
    m = s.match(/\bNCB[\s-]*(\d+(?:\.\d+)?)\s*%/i);
    if (m) {
      tiers.push({
        tag: 'NCB 1-99',
        ncb_min: 1, ncb_max: 99,
        ncb_marker: 'NCB 1-99%',
        rate: parseFloat(m[1]) / 100,
      });
    }
  }
  // "Non NCB- 19.5%" → NCB=0
  m = s.match(/Non\s*NCB[\s-]*(\d+(?:\.\d+)?)\s*%/i);
  if (m) {
    tiers.push({
      tag: 'NCB=0',
      ncb_min: 0, ncb_max: 0,
      ncb_marker: 'NCB = 0%',
      rate: parseFloat(m[1]) / 100,
    });
  }
  return tiers;
}

// ----------------------------------------------------------------------------
// Entry — parse the entire .msg file
// ----------------------------------------------------------------------------
async function parseMsgFile(filePath) {
  const body = readMsgBody(filePath);
  if (!body) {
    console.warn('[raheja] empty MSG body');
    return [];
  }
  const lines = body.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  // Extract month/year for remarks (e.g. "Apr'26")
  const monthMatch = body.match(/[A-Z][a-z]{2}'?\d{2}/);
  const gridMonth = monthMatch ? monthMatch[0] : 'Current';
  const meta = { sheetName: path.basename(filePath), gridMonth };

  const zoneMap = parseZoneMap(body);
  if (Object.keys(zoneMap).length === 0) {
    console.warn('[raheja] zone map empty — using defaults');
    Object.assign(zoneMap, {
      North:  ['Jammu & Kashmir','Himachal Pradesh','Uttarakhand','Punjab','Chandigarh','Haryana','Delhi','Uttar Pradesh','Chhattisgarh'],
      Centre: ['Rajasthan','Madhya Pradesh'],
      East:   ['West Bengal','Bihar','Odisha','Jharkhand'],
      West:   ['Maharashtra','Gujarat','Goa','Daman & Diu','Dadra & Nagar Haveli'],
      South:  ['Andhra Pradesh','Telangana','Tamil Nadu','Karnataka','Puducherry'],
    });
  }

  const rules = [];
  emitGridSection(rules, meta, lines, GCV_TYPES,  'GCV', zoneMap);
  emitGridSection(rules, meta, lines, PCV_TYPES,  'PCV', zoneMap);
  emitGridSection(rules, meta, lines, MISD_TYPES, 'MIS', zoneMap);
  emitPvtCarSection(rules, meta, lines, zoneMap);
  return rules;
}

module.exports = { parseMsgFile };
