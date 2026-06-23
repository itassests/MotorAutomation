/**
 * Liberty (Robinhood broker) — NEW June-format CV grid.
 *
 * Liberty switched from the old combined "GCV3W & 4W,<7.5T" sheets to split
 * Comp/SATP product sheets. The CV sheets share one regular shape:
 *   R(band_header_row): band-group labels, each spanning its age columns
 *       e.g. "0 - 2.5T" | "2.5 - 3.5T" | "3.5 - 7.5T" | "PCV 3W" | "GCV 3W"
 *            "7.5 - 12T" | "12 - 20T"   | "20 - 43.5T" | "MISD Tractors"
 *   R(age_header_row):  per-band age tiers — New | >1-5 | >5-10 | >10 Years
 *   R(data_start_row)+: Geo Segment (col 0) + a rate per (band × age) cell
 *
 * Each sheet is a single rate_type (COMP or SATP), set in config. Weight-band
 * labels become GCV 4W weight bands; "PCV 3W"/"GCV 3W"/"MISD Tractors" become
 * their own product/segment (no weight band). region = the Geo Segment cluster
 * (matched downstream via liberty's RTO→cluster mappings).
 */

function parseBand(label) {
  const s = String(label || '').trim();
  if (/pcv\s*3\s*w/i.test(s))                return { product: 'PCV',  segment: 'PCV 3W', label: s };
  if (/gcv\s*3\s*w/i.test(s))                return { product: 'GCV',  segment: 'GCV 3W', label: s };
  if (/mis[\s-]?d|tractor/i.test(s))         return { product: 'MISC', segment: 'MISD Tractor', label: s };
  const m = s.match(/([\d.]+)\s*[-–]\s*([\d.]+)\s*T/i);
  if (m) return { product: 'GCV', segment: 'GCV', wmin: parseFloat(m[1]), wmax: parseFloat(m[2]), label: s };
  return null;
}

function parseAge(label) {
  const s = String(label || '').trim().toLowerCase();
  if (/^new$/.test(s))                 return { min: 0,  max: 0,  label: 'New' };
  if (/1\s*[-–]\s*5/.test(s))          return { min: 1,  max: 5,  label: '>1-5' };
  if (/5\s*[-–]\s*10/.test(s))         return { min: 6,  max: 10, label: '>5-10' };
  if (/\b10\b/.test(s) && />/.test(s)) return { min: 11, max: 99, label: '>10' };
  if (/^>?\s*10/.test(s))              return { min: 11, max: 99, label: '>10' };
  return null;
}

function parseRate(v) {
  if (v == null || v === '' || v === '-') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(n)) return null;
  return n > 1 ? n / 100 : +n.toFixed(6);
}

function parse(sheetData, sheetConfig, meta) {
  const rt = sheetConfig.rate_type || 'COMP';
  const bandRow = sheetData[sheetConfig.band_header_row != null ? sheetConfig.band_header_row : 1] || [];
  const ageRow  = sheetData[sheetConfig.age_header_row  != null ? sheetConfig.age_header_row  : 2] || [];
  const dataStart = sheetConfig.data_start_row != null ? sheetConfig.data_start_row : 3;

  // Band-group starts = non-empty cells in the band header row (cols ≥ 1).
  const starts = [];
  for (let c = 1; c < bandRow.length; c++) {
    if (String(bandRow[c] || '').trim()) starts.push(c);
  }
  // Build the (col → band, age) plan.
  const cols = [];
  for (let gi = 0; gi < starts.length; gi++) {
    const start = starts[gi];
    const end = gi + 1 < starts.length ? starts[gi + 1] : ageRow.length;
    const band = parseBand(bandRow[start]);
    if (!band) continue;
    for (let c = start; c < end; c++) {
      const age = parseAge(ageRow[c]);
      if (age) cols.push({ col: c, band, age });
    }
  }
  if (!cols.length) return [];

  const rules = [];
  for (let r = dataStart; r < sheetData.length; r++) {
    const row = sheetData[r];
    if (!row) continue;
    const geo = String(row[0] || '').trim();
    if (!geo || /geo\s*segment/i.test(geo)) continue;
    for (const cc of cols) {
      const rate = parseRate(row[cc.col]);
      if (rate == null) continue;     // blank → no rule; 0 kept as decline
      rules.push({
        product: cc.band.product,
        sheet_name: meta.sheetName,
        segment: cc.band.segment,
        region: geo,
        make: 'All',
        weight_band_min: cc.band.wmin != null ? cc.band.wmin : null,
        weight_band_max: cc.band.wmax != null ? cc.band.wmax : null,
        vehicle_age_min: cc.age.min,
        vehicle_age_max: cc.age.max,
        rate_type: rt,
        rate_value: rate === 0 ? null : rate,
        is_declined: rate === 0,
        rate_text: `${geo} | ${cc.band.label} | ${cc.age.label}`,
      });
    }
  }
  return rules;
}

module.exports = { parse, parseBand, parseAge };
