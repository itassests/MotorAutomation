/**
 * Parses conditional rate text found in insurance rate cells.
 *
 * Real-world cells contain many variations:
 *   "Age 0-2: 55%\nAge 3+: 65%"
 *   "Age 0-2yrs -45% & Age 3+yrs -50%"
 *   "All Make Age 0-2yrs -50% & Age 3+yrs -55%"
 *   "0-5yrs-21%, 5+ yrs-28.5%"
 *   "Age 0-5 -5%\nAge>=5 -12.5%"
 *   "70%/80%"
 *   "Mahindra & AL -0% ,Rest -80%"
 */

/**
 * Extract a percentage value from a string fragment and return as a decimal.
 * "55%" → 0.55, "-45%" → 0.45, "28.5%" → 0.285
 * @param {string} fragment
 * @returns {number|null}
 */
function extractPercent(fragment) {
  const m = fragment.match(/-?\s*([\d.]+)\s*%/);
  if (!m) return null;
  return parseFloat(m[1]) / 100;
}

/**
 * Parse conditional rate text into an array of condition objects.
 *
 * @param {string} text - The raw conditional text from a cell
 * @returns {Array<{
 *   condition_type: string,
 *   condition_min: number|null,
 *   condition_max: number|null,
 *   condition_text: string,
 *   rate_value: number|null
 * }>}
 */
function parseConditionalText(text) {
  if (!text || typeof text !== 'string') return [];

  const trimmed = text.trim();
  if (!trimmed) return [];

  // ── Pattern 1: Slash-separated rates like "70%/80%" ──
  const slashMatch = trimmed.match(/^([\d.]+)%\s*\/\s*([\d.]+)%$/);
  if (slashMatch) {
    return [
      {
        condition_type: 'tier',
        condition_min: null,
        condition_max: null,
        condition_text: 'rate1',
        rate_value: parseFloat(slashMatch[1]) / 100,
      },
      {
        condition_type: 'tier',
        condition_min: null,
        condition_max: null,
        condition_text: 'rate2',
        rate_value: parseFloat(slashMatch[2]) / 100,
      },
    ];
  }

  // ── Pattern 2: Make-based conditions ──
  // "Mahindra & AL -0% ,Rest -80%"
  // Heuristic: contains "Rest" keyword and a make name before it
  const makeRestMatch = trimmed.match(
    /^(.+?)\s*-\s*([\d.]+)%\s*[,&]\s*Rest\s*-\s*([\d.]+)%$/i
  );
  if (makeRestMatch) {
    return [
      {
        condition_type: 'make',
        condition_min: null,
        condition_max: null,
        condition_text: makeRestMatch[1].trim(),
        rate_value: parseFloat(makeRestMatch[2]) / 100,
      },
      {
        condition_type: 'make',
        condition_min: null,
        condition_max: null,
        condition_text: 'Rest',
        rate_value: parseFloat(makeRestMatch[3]) / 100,
      },
    ];
  }

  // ── Pattern 3: Age-based conditions ──
  // Split on newlines, "&", "," — but be careful with "&" inside make names
  // First, normalise separators. We split on \n, or "& Age", or ", " before digits
  // to get individual condition fragments.
  const fragments = splitConditions(trimmed);

  if (fragments.length > 0) {
    const results = [];
    for (const frag of fragments) {
      const parsed = parseAgeFragment(frag.trim());
      if (parsed) {
        results.push(parsed);
      }
    }
    if (results.length > 0) return results;
  }

  // ── Fallback: return the whole text as a single opaque condition ──
  const fallbackRate = extractPercent(trimmed);
  return [
    {
      condition_type: 'unknown',
      condition_min: null,
      condition_max: null,
      condition_text: trimmed,
      rate_value: fallbackRate,
    },
  ];
}

/**
 * Split conditional text into individual condition fragments.
 * Handles separators: newline, " & " (when followed by age-like text), ", " before digits.
 */
function splitConditions(text) {
  // Replace \n with a unique separator
  let normalized = text.replace(/\r?\n/g, '|||');

  // Split on " & " when it precedes age-like text (Age, digit, All)
  // But NOT when it's part of a make name like "Mahindra & AL"
  normalized = normalized.replace(
    /\s*&\s*(?=(?:Age|All\s*Make|\d))/gi,
    '|||'
  );

  // Split on ", " when followed by a digit or "Age"
  normalized = normalized.replace(
    /\s*,\s*(?=\d|Age)/gi,
    '|||'
  );

  const parts = normalized.split('|||').map((s) => s.trim()).filter(Boolean);
  return parts;
}

/**
 * Parse a single age-condition fragment like:
 *   "Age 0-2: 55%"
 *   "Age 3+: 65%"
 *   "Age 0-2yrs -45%"
 *   "Age 3+yrs -50%"
 *   "All Make Age 0-2yrs -50%"
 *   "0-5yrs-21%"
 *   "5+ yrs-28.5%"
 *   "Age 0-5 -5%"
 *   "Age>=5 -12.5%"
 */
function parseAgeFragment(frag) {
  if (!frag) return null;

  // Strip leading qualifiers like "All Make"
  let s = frag.replace(/^All\s*Make\s*/i, '').trim();

  const rate = extractPercent(s);
  if (rate === null) return null;

  // Try to extract age range/bounds

  // "Age 0-2" or "0-2yrs" or "0 - 2 yrs"
  let m = s.match(/(?:Age\s*)?([\d]+)\s*-\s*([\d]+)\s*(?:yrs|years)?/i);
  if (m) {
    return {
      condition_type: 'age',
      condition_min: parseInt(m[1], 10),
      condition_max: parseInt(m[2], 10),
      condition_text: frag.trim(),
      rate_value: rate,
    };
  }

  // "Age 3+" or "3+ yrs" or "3+yrs"
  m = s.match(/(?:Age\s*)?([\d]+)\s*\+\s*(?:yrs|years)?/i);
  if (m) {
    return {
      condition_type: 'age',
      condition_min: parseInt(m[1], 10),
      condition_max: 99,
      condition_text: frag.trim(),
      rate_value: rate,
    };
  }

  // "Age>=5" or "Age >= 5" or "Age > 5"
  m = s.match(/Age\s*>=?\s*([\d]+)/i);
  if (m) {
    return {
      condition_type: 'age',
      condition_min: parseInt(m[1], 10),
      condition_max: 99,
      condition_text: frag.trim(),
      rate_value: rate,
    };
  }

  // "Age<=5" or "Age < 5"
  m = s.match(/Age\s*<=?\s*([\d]+)/i);
  if (m) {
    return {
      condition_type: 'age',
      condition_min: 0,
      condition_max: parseInt(m[1], 10),
      condition_text: frag.trim(),
      rate_value: rate,
    };
  }

  // "Age 0-5 -5%" — already caught above, but just in case
  // Fallback: no age info extracted, treat as unknown
  return {
    condition_type: 'unknown',
    condition_min: null,
    condition_max: null,
    condition_text: frag.trim(),
    rate_value: rate,
  };
}

module.exports = { parseConditionalText };
