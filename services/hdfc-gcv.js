// HDFC GCV rate resolver.
//
// HDFC's GCV grid ("GCV Grid Effective 01042026 - With RTO List.xlsx") is a
// free-text conditional grid: rows = (State, Location-group, weight-band),
// columns = Base-Comp | Base-SATP | Approved-Comp | Approved-SATP, and each cell
// is either a plain rate or a natural-language rule keyed by MAKE
// (Tata / Mahindra-Bolero / Eicher / others) × AGE × location. The generic
// parser flattened these cells into ambiguous numeric rows (losing the make/age
// conditions), so the engine couldn't pick the right rate. This module reads the
// pre-extracted grid (config/hdfc_gcv_grid.json) and interprets the APPROVED
// cell for a given policy (make/model, age, weight-band, region) to recover the
// intended rate. Returns:
//   number  → fraction rate (e.g. 0.50)
//   null    → policy is DECLINED by the grid (force zero commission)
//   undefined → could not resolve confidently (caller leaves the existing rule)
//
// Scope: HDFC GCV only. Bulk.js calls resolveGcvRate() and overrides the COMP/
// SATP rule only when a number/null comes back, so anything it can't parse keeps
// the engine's existing behaviour (no regressions on un-handled shapes).

const path = require('path');
let GRID = null;
function grid() {
  if (!GRID) { try { GRID = require(path.join(__dirname, '..', 'config', 'hdfc_gcv_grid.json')); } catch (_) { GRID = []; } }
  return GRID;
}

function pct(s) {
  s = String(s).trim();
  const m = s.match(/([\d.]+)\s*%/);
  if (m) return parseFloat(m[1]) / 100;
  const n = parseFloat(s);
  if (!isNaN(n)) return n > 1 ? n / 100 : n;
  return null;
}

// Interpret one Approved cell against the policy context.
// base = the Base-column cell (needed to resolve "Grid+N%").
function interpret(text, base, ctx) {
  let t = String(text || '').trim();
  if (!t) return undefined;
  const gm = t.match(/grid\s*\+\s*([\d.]+)\s*%/i);
  if (gm) { const b = interpret(base, null, ctx); return b == null ? b : +(b + parseFloat(gm[1]) / 100).toFixed(4); }
  if (/^\s*decline\s*$/i.test(t)) return null;
  // Grid exclusion: cells noting "(nin Eicher non Bharat)" decline Eicher (and
  // non-Bharat-stage) vehicles in that band — for an Eicher, treat as declined.
  if (/nin\s+eicher/i.test(t) && ctx.isEicher) return null;
  if (!/tata|bolero|eicher|mahindra|other|rest|year|age|decline|<|>/i.test(t)) return pct(t);

  const low = ' ' + t.toLowerCase().replace(/\s+/g, ' ') + ' ';
  const age = Number(ctx.age) || 0;
  const { isBolero, isTata, isEicher } = ctx;
  const isMah = ctx.isMahindra;
  let m;
  // "X% in Bolero <4 years, Y% in Bolero >4 years, Z% in <2 years others and W% in >2 years others"
  m = low.match(/([\d.]+)% in bolero <\s*4 years.*?([\d.]+)% in bolero >\s*4 years.*?([\d.]+)% in <\s*2 years others.*?([\d.]+)% in >\s*2 years others/);
  if (m) { if (isBolero) return age < 4 ? +m[1] / 100 : +m[2] / 100; return age < 2 ? +m[3] / 100 : +m[4] / 100; }
  // "Bolero <5 years A%, >5 years B%, others ..."
  m = low.match(/bolero <\s*5 years ([\d.]+)%,?\s*>\s*5 years ([\d.]+)%,?\s*others(.*)$/);
  if (m) {
    const A = +m[1] / 100, B = +m[2] / 100, oth = m[3];
    if (isBolero) return age >= 5 ? B : A;
    const om = oth.match(/>\s*5 years ([\d.]+)%.*?<\s*5 years ([\d.]+)%/);
    if (om) return age >= 5 ? +om[1] / 100 : +om[2] / 100;
    const of = oth.match(/([\d.]+)%/); return of ? +of[1] / 100 : null;
  }
  // "Bolero age 0-4 decline, others X%"
  m = low.match(/bolero age 0-4 decline,\s*others ([\d.]+)%/);
  if (m) { if (isBolero && age <= 4) return null; return +m[1] / 100; }
  // "47.5% in Bolero, 50% in Others"
  m = low.match(/([\d.]+)% in bolero,\s*([\d.]+)% in others/);
  if (m) return isBolero ? +m[1] / 100 : +m[2] / 100;
  // "60% in Tata and 55% Otherwise"
  m = low.match(/([\d.]+)% in tata and ([\d.]+)% otherwise/);
  if (m) return isTata ? +m[1] / 100 : +m[2] / 100;
  // "tata X%, others Y%" / "X% Tata, Y% Others"
  m = low.match(/tata ([\d.]+)%,\s*others ([\d.]+)%/) || low.match(/([\d.]+)% tata,\s*([\d.]+)% others/);
  if (m) return isTata ? +m[1] / 100 : +m[2] / 100;
  // "Tata-& Mahindra- 40%, rest decline" / "25% for Tata & Mahindra rest decline"
  m = low.match(/tata-?\s*&?\s*mahindra-?\s*([\d.]+)%,?\s*rest decline/) || low.match(/([\d.]+)% for tata & mahindra rest decline/);
  if (m) return (isTata || isMah || isBolero) ? +m[1] / 100 : null;
  // "Tata age >4 X%, others age >4 Y%, Tata age <=4 Z% [, others age <4 W%]"
  m = low.match(/tata age ?>\s*4 ([\d.]+)%.*?others age ?>\s*4,? ?([\d.]+)%.*?tata age ?<=\s*4 ([\d.]+)%(.*?others age ?<\s*4 ([\d.]+)%)?/);
  if (m) { if (isTata) return age > 4 ? +m[1] / 100 : +m[3] / 100; if (age > 4) return +m[2] / 100; return m[5] ? +m[5] / 100 : +m[2] / 100; }
  // "Tata 30%, Eicher Age >4 30%, others age >4, 25%"
  m = low.match(/tata ([\d.]+)%,\s*eicher age ?>\s*4 ([\d.]+)%,\s*others age ?>\s*4,? ?([\d.]+)%/);
  if (m) { if (isTata) return +m[1] / 100; if (isEicher) return age > 4 ? +m[2] / 100 : null; return age > 4 ? +m[3] / 100 : null; }
  // "Tata [age > 4] X%, others Age>4 Y%" / "Tata 15%, others Age>4 15%"
  m = low.match(/tata (?:age ?> ?4 )?([\d.]+)%,\s*others age ?> ?4 ([\d.]+)%/);
  if (m) { if (isTata) return +m[1] / 100; return age > 4 ? +m[2] / 100 : null; }
  // "Tata 30%, Other Age4 >30%"
  m = low.match(/tata ([\d.]+)%,\s*other age ?4? ?>?\s*([\d.]+)%/);
  if (m) return isTata ? +m[1] / 100 : +m[2] / 100;
  // "Age >4 X%, Age <4|0-4 Y%"
  m = low.match(/age ?> ?4 ([\d.]+)%,\s*age (?:<\s*4|0-4) ([\d.]+)%/);
  if (m) return age > 4 ? +m[1] / 100 : +m[2] / 100;
  // "age >4, X%" (only >4 specified → younger declines)
  m = low.match(/age ?> ?4,? ([\d.]+)%/);
  if (m) return age > 4 ? +m[1] / 100 : null;
  // "X%, <5 years decline" / "X%, <=2 years decline"
  m = low.match(/([\d.]+)%,\s*<\s*5 years decline/); if (m) return age < 5 ? null : +m[1] / 100;
  m = low.match(/([\d.]+)%,\s*<=\s*2 years decline/); if (m) return age <= 2 ? null : +m[1] / 100;
  // "20% age>4"
  m = low.match(/([\d.]+)% age ?> ?4/); if (m) return age > 4 ? +m[1] / 100 : null;
  return undefined; // unparsed → caller keeps existing rule
}

function bandFromCat(cat, makeModel) {
  const c = String(cat || '').toLowerCase();
  if (/3w|3 w|e-?rik|e-?rick/.test(c) || /\bape\b|maxima|atul|piaggio|shakti|gem\b/.test(String(makeModel || '').toLowerCase())) return '3W';
  if (/upto 2\.5|0-2\.5|<2\.5|upto 2500|<\s*2500/.test(c)) return '0-2.5T';
  if (/2\.5-3\.5|2\.5 ?- ?3\.5|2500-3500/.test(c)) return '2.5-3.5T';
  if (/3\.5-7\.5|3\.5 ?- ?7|3500-7500/.test(c)) return '3.5-7.5T';
  if (/7\.5-12|7500-12000/.test(c)) return '7.5-12T';
  if (/12-?20|12-?17|12000-/.test(c)) return '12-17T';
  if (/20-?40|20-?25|40 ?tn|>40|>\s*40/.test(c)) return '20-25T';
  return null;
}

const ST = { MH: 'Maharashtra', GJ: 'Gujarat', DL: 'Delhi', KA: 'Karnataka', WB: 'West Bengal',
  TG: 'Telangana', TS: 'Telangana', AP: 'Andhra Pradesh', HP: 'Himachal Pradesh', AS: 'Assam',
  OD: 'Odisha', OR: 'Odisha', PB: 'Punjab', CH: 'Chandigarh', JH: 'Jharkhand', BR: 'Bihar',
  UA: 'Uttarakhand', UK: 'Uttarakhand', ML: 'Meghalaya', MZ: 'Mizoram', TR: 'Tripura' };

// Authoritative RTO → GCV location-group map, ingested from the HDFC "Final Grid"
// workbook Sheet1 (RTO | RTO Name | Region): MH42 Baramati→"Maharashtra Good",
// GJ01/18/27/38/28/05→"Ahmedabad", GJ17/31/20/…→"Gujarat Bad", etc. This is the
// real GCV RTO-quality classification — HDFC's rto_mappings (from the TW grid,
// product=NULL) and the booked-location fallback don't carry it, so the vehicle
// REGISTRATION RTO mapped through this table is authoritative for the GCV grid.
let GCV_RTO = null;
function gcvRtoMap() {
  if (!GCV_RTO) { try { GCV_RTO = require(require('path').join(__dirname, '..', 'config', 'hdfc_gcv_rto.json')); } catch (_) { GCV_RTO = {}; } }
  return GCV_RTO;
}

function gridLoc(region, rtoState, rtoCode) {
  const r = String(region || '').toUpperCase();
  const code = String(rtoCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  // Authoritative registration-RTO → (state, loc) wins over the region-name
  // heuristics below (which depend on the often-wrong resolved/booked region).
  const fromCode = code && gcvRtoMap()[code];
  if (fromCode && fromCode.state && fromCode.loc) return { state: fromCode.state, loc: fromCode.loc };
  // Gujarat: Sheet1 enumerates the Ahmedabad + Bad RTOs explicitly; any GJ RTO
  // NOT listed is the residual "Others, DD, DN" group — NOT "Bad" (the
  // TW-derived rto_mapping wrongly tags some unlisted GJ RTOs like GJ14 as "ROG
  // Bad locations"). Default unlisted GJ codes to Others, overriding region-name.
  if (code.startsWith('GJ')) return { state: 'Gujarat', loc: 'Others, DD, DN' };
  let loc = null;
  // Specific city groups FIRST — note "BAD" must use a word boundary, else it
  // false-matches "ahmedaBAD"/"ahemedaBAD".
  if (/PUNE|MUMBAI|GOA/.test(r)) loc = 'Mumbai, Pune, Goa';
  else if (/NAGPUR|NASHIK/.test(r)) loc = 'Nagpur, Nashik';
  else if (/AHMEDABAD|AHEMEDABAD|SURAT/.test(r)) loc = 'Ahemedabad, Surat';
  else if (/\bBAD\b/.test(r)) loc = 'Bad';
  else if (/REST OF GUJARAT|\bROG\b|OTHERS, DD|\bDD\b|\bDN\b/.test(r)) loc = 'Others, DD, DN';
  else if (/GOOD/.test(r)) loc = 'Good';
  else if (/BANGALORE|BENGALURU/.test(r)) loc = 'Bangalore';
  else if (/KOLKATA/.test(r)) loc = 'Kolkata';
  else if (/SILIGURI|HOWRAH/.test(r)) loc = 'Siliguri, Howrah';
  else if (/NCR|DELHI/.test(r)) loc = 'All';
  let state = ST[rtoState] || null;
  if (!state) {
    if (/GUJARAT|ROG/.test(r) || code.startsWith('GJ')) state = 'Gujarat';
    else if (/MAHA|PUNE|MUMBAI|NAGPUR|NASHIK/.test(r) || code.startsWith('MH')) state = 'Maharashtra';
    else if (/NCR|DELHI/.test(r)) state = 'Delhi';
  }
  return { state, loc };
}

function findRow(state, loc, band) {
  const rows = grid().filter(r => r.state === state && r.band === band);
  if (!rows.length) return null;
  return rows.find(r => r.loc === loc)
      || rows.find(r => /^all/i.test(r.loc))
      || rows.find(r => /others/i.test(r.loc))
      || rows[0];
}

/**
 * Resolve the HDFC GCV approved rate for a policy.
 * @returns {number|null|undefined}
 */
function resolveGcvRate(params, resolvedRegion, rtoState, isSatp) {
  const make = String(params.make || '').toUpperCase();
  const model = String(params.model || '').toUpperCase();
  const cat = String(params.vehicleCategory || '').toUpperCase();
  // HDFC declines electric 3-wheeler GOODS carriers ("E-Rikshaw-Good Carrying").
  // Distinct from the rated "GCV - 3W" autos (which match at 0.65), so this is a
  // targeted category decline — returns null (zero commission).
  if (/E-?RIK|E-?RICK/.test(cat)) return null;
  const band = bandFromCat(params.vehicleCategory, make + ' ' + model);
  if (!band) return undefined;
  const { state, loc } = gridLoc(resolvedRegion, rtoState, params.rtoCode);
  if (!state) return undefined;
  const row = findRow(state, loc, band);
  if (!row) return undefined;
  // HDFC's "Tata" premium in the GCV cells applies to LIGHT Tata (Ace/SCV/pickup,
  // ≤3.5T). HEAVY Tata trucks (LPT/LPK, >7.5T) take the "others" rate instead, so
  // for the heavy bands a Tata is treated as "others" (isTata=false). (Confirmed:
  // GJ9/816 Tata LPT 12-17T → operator used "others 25%"+5%=30, not Tata 30%+5%=35.)
  const HEAVY_BANDS = new Set(['7.5-12T', '12-17T', '20-25T']);
  const ctx = {
    isBolero: /BOLERO/.test(model),
    isTata: /TATA/.test(make) && !HEAVY_BANDS.has(band),
    isMahindra: /MAHINDRA/.test(make),
    isEicher: /EICHER/.test(make + ' ' + model),
    age: Number(params.vehicleAge) || 0,
  };
  return interpret(isSatp ? row.apprSatp : row.apprComp, isSatp ? row.baseSatp : row.baseComp, ctx);
}

module.exports = { resolveGcvRate, interpret, bandFromCat, gridLoc };
