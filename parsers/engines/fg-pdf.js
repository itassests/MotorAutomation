/**
 * Future Generali — PDF grid parser.
 *
 * The FG monthly grid is shipped as a 2-page PDF with multiple LoB tables
 * intermixed.  We only extract the in-scope MOTOR sections:
 *   • Pvt Car Comprehensive — 6-tier slab grid:
 *       0-50k / >50k-1L / >1L-2.5L / >2.5L-5L / >5L-10L / >10L
 *     Each tier carries an IRDA cap (15%) and a Pvt Car Comp payout rate
 *     that scales 4.50% → 15.00%.
 *   • Pvt Car TP only — doable state list (Petrol/Diesel) at IRDA SATP rate
 *     (firm-wide 2.5%).  Non-listed states are implicitly declined.
 *
 * Out-of-scope (skipped): PA, WC, Trade Plate, Tractor (mostly motor-
 * adjacent and the user said scope = Pvt Car Comp + TP only).
 */

const { PDFParse } = require('pdf-parse');
const fs = require('fs');
const { irdaRateFor } = require('../utils/irda-rates');

// Premium-slab labels in the PDF → (min, max) in Lakhs.
const COMP_SLABS = [
  { match: /^0\s*-\s*50k$/i,                  label: '0-50K',     pmin: 0,    pmax: 0.5 },
  { match: /^>?\s*50k\s*-\s*1\s*Lac/i,        label: '50K-1L',    pmin: 0.5,  pmax: 1   },
  { match: /^>?\s*1\s*Lac\s*-\s*2\.5\s*Lacs/i,label: '1L-2.5L',   pmin: 1,    pmax: 2.5 },
  { match: /^>?\s*2\.5\s*Lacs?\s*-\s*5\s*Lacs/i, label: '2.5L-5L',pmin: 2.5,  pmax: 5   },
  { match: /^>?\s*5\s*Lacs?\s*-\s*10\s*Lacs/i,label: '5L-10L',    pmin: 5,    pmax: 10  },
  { match: /^>\s*10\s*Lacs?/i,                label: '>10L',      pmin: 10,   pmax: null},
];

/**
 * Extract Pvt Car Comprehensive Policy slab rules from PDF text lines.
 * Each matching line has shape: "<slab> 15% <rate>%" where 15% is the IRDA cap
 * column (constant across slabs) and the third number is the slab payout.
 * Returns: { rules: ruleSpec[] }
 */
function parsePvtCarComp(lines, meta) {
  const rules = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+/g, ' ').trim();
    // Detect "<slab-text> <irda>% <rate>%" — IRDA is typically 15% but we don't gate on it
    const m = line.match(/^([>]?\s*[\d.]+\s*[a-zA-Z]+\s*-\s*[\d.]+\s*Lacs?|>?\s*\d+\s*Lacs?|0\s*-\s*50k|>?\s*50k\s*-\s*1\s*Lac)\s+(\d+(?:\.\d+)?)\s*%\s+(\d+(?:\.\d+)?)\s*%$/);
    if (!m) continue;
    const slabText = m[1].trim();
    const irdaPct = parseFloat(m[2]);
    const ratePct = parseFloat(m[3]);
    const slab = COMP_SLABS.find(s => s.match.test(slabText));
    if (!slab) continue;
    // Effective Netpoint = IRDA base + slab addition (per user spec).
    // The PDF lays out: <slab> | <IRDA %> | <addition %>
    //   0-50k         15%   4.50%   →  19.50% Netpoint
    //   > 10 Lacs     15%   15.00%  →  30.00% Netpoint
    const finalPct = irdaPct + ratePct;
    rules.push({
      product: 'CAR',
      sheet_name: meta.sheetName || 'PDF Grid',
      segment: 'Pvt Car',
      make: 'All',
      rate_type: 'COMP',
      applied_on: 'NET',                       // Netpoint per user spec
      rate_value: Number((finalPct / 100).toFixed(4)),
      is_declined: false,
      volume_tier: slab.label,
      remarks: `IRDA ${irdaPct}% + ${ratePct}% addition = ${finalPct}% Netpoint`,
      rate_text: `Pvt Car Comp | ${slab.label} | IRDA(${irdaPct}%)+${ratePct}% = ${finalPct}%`,
    });
  }
  return rules;
}

/**
 * Extract the Pvt Car TP-only doable state list.  In the PDF the section
 * looks like:
 *   Pvt Car TP only policy
 *   Petrol
 *   Diesel
 *   Andaman and Nicobar, Goa, Delhi,
 *   Assam, Chandigarh, Bihar, Telangana,
 *   UP, HP, Maharashtra, Gujarat, Punjab
 *   and WB
 *   PVTP doable states
 *
 * Emits one TP rule per (state × fuel) at IRDA SATP rate (firm-wide).
 */
const TP_FUELS = ['Petrol', 'Diesel'];

function parsePvtCarTp(text, meta) {
  const rules = [];
  // Locate the section between "Private Car TP only policy" and "PVTP doable states".
  const sec = text.match(/(?:Private\s+Car|Pvt\s+Car)\s+TP\s+only\s+policy([\s\S]*?)PVTP\s+doable\s+states/i);
  if (!sec) return rules;
  const blob = sec[1];

  // Strip "Petrol" / "Diesel" labels then collect comma/and-separated state names.
  const stateBlob = blob
    .replace(/\b(Petrol|Diesel)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Split on commas only first (keeps compound names like "Andaman and Nicobar"
  // intact).  Then split each chunk on " and " but only the LAST occurrence
  // is a list separator — interior "and"s are part of state names.
  const rawStates = stateBlob.split(/\s*,\s*/);
  const states = [];
  for (let i = 0; i < rawStates.length; i++) {
    let chunk = rawStates[i].trim();
    if (!chunk) continue;
    // Last chunk often shaped "<state-or-list> and <state>". Only split when
    // both halves look like a single state name (no internal "and").
    if (i === rawStates.length - 1 && /\s+and\s+/i.test(chunk)) {
      const parts = chunk.split(/\s+and\s+/i);
      // If first part is a multi-word "Andaman" prefix (canonical "Andaman and
      // Nicobar"), keep the chunk intact; otherwise treat the " and " as the
      // final list separator.
      if (parts.length === 2 && /Andaman/i.test(parts[0]) && /Nicobar/i.test(parts[1])) {
        states.push(chunk);
      } else {
        for (const p of parts) {
          const t = p.trim();
          if (t) states.push(t);
        }
      }
    } else {
      states.push(chunk);
    }
  }
  const cleaned = states
    .map(s => s.trim())
    .filter(s => s.length > 0 && !/^(and|Pvt|Private|Car|TP|only|policy)$/i.test(s));
  if (cleaned.length === 0) return rules;

  // Per user spec: doable states get Petrol 30% / Diesel 20% (NOT IRDA).
  // Headers on the PDF page show "30%" for Petrol and "20%" for Diesel.
  const TP_FUEL_RATES = { Petrol: 0.30, Diesel: 0.20 };
  for (const state of cleaned) {
    for (const fuel of TP_FUELS) {
      rules.push({
        product: 'CAR',
        sheet_name: meta.sheetName || 'PDF Grid',
        region: state,
        state: state,
        segment: 'Pvt Car',
        make: 'All',
        fuel_type: fuel,
        rate_type: 'TP',
        applied_on: 'TP',
        rate_value: TP_FUEL_RATES[fuel],
        is_declined: false,
        remarks: `Pvt Car TP-only doable state — ${fuel} @ ${(TP_FUEL_RATES[fuel] * 100).toFixed(0)}%`,
        rate_text: `Pvt Car TP | ${state} | ${fuel} @ ${(TP_FUEL_RATES[fuel] * 100).toFixed(0)}%`,
      });
    }
  }
  return rules;
}

/**
 * Entry point — given a PDF file path, returns the rule list.
 */
async function parsePdfFile(filePath) {
  const buf = fs.readFileSync(filePath);
  const p = new PDFParse({ data: buf });
  const result = await p.getText();
  const text = result.text || '';
  const lines = text.split(/\n+/);

  const meta = { sheetName: 'FG Grid (PDF)' };
  const rules = [
    ...parsePvtCarComp(lines, meta),
    ...parsePvtCarTp(text, meta),
  ];
  return rules;
}

module.exports = { parsePdfFile, parsePvtCarComp, parsePvtCarTp };
