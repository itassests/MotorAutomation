/**
 * Product classification based on segment text.
 *
 * Maps raw segment names to proper product categories:
 *   GCV   - Goods Commercial Vehicle (GCV3, GCV4, E-Loaders, JCB, Tractor, etc.)
 *   PCV   - Passenger Commercial Vehicle (Taxi, PCV3W, Bus, Auto, Maxi Cab)
 *   CAR   - Private Car / 4-Wheeler (Petrol/Diesel/CNG CC bands, PC segments)
 *   TW    - Two Wheeler (MC, SC, Scooter, 150cc, 350cc etc.)
 *   TW_EV - Two Wheeler Electric (KW segments)
 *   MISC  - Miscellaneous (Misc D, Non-Motor, etc.)
 */

const PRODUCT_RULES = [
  // MISC - Miscellaneous (must be before GCV to catch these vehicle types)
  // Misc D, Tractor, JCB, Loader, Backhoe, Forklift, Excavator, Harvester
  { pattern: /Backhoe\s*loader|Forklift|Excavator.*loader/i, product: 'MISC', label: 'Miscellaneous' },
  { pattern: /^JCB/i, product: 'MISC', label: 'Miscellaneous' },
  { pattern: /Tractor/i, product: 'MISC', label: 'Miscellaneous' },
  { pattern: /^TRAC/i, product: 'MISC', label: 'Miscellaneous' },
  { pattern: /E-Loader/i, product: 'MISC', label: 'Miscellaneous' },
  { pattern: /EXCAVATOR|HARVESTOR/i, product: 'MISC', label: 'Miscellaneous' },

  // PCV - E-Rickshaw and E-Auto are passenger commercial vehicles
  { pattern: /E-Rickshaw/i, product: 'PCV', label: 'Passenger Commercial Vehicle' },
  { pattern: /E-Auto/i, product: 'PCV', label: 'Passenger Commercial Vehicle' },

  // GCV - Goods Commercial Vehicle
  { pattern: /^GCV/i, product: 'GCV', label: 'Goods Commercial Vehicle' },
  { pattern: /GCCV/i, product: 'GCV', label: 'Goods Commercial Vehicle' },
  { pattern: /UPTO_3\.5T|3\.5T_TO|7\.5T_TO|12T_TO|16T_TO|20T_TO|40T_TO|43T_TO|ABOVE_43T/i, product: 'GCV', label: 'Goods Commercial Vehicle' },

  // PCV - Passenger Commercial Vehicle
  { pattern: /Taxi/i, product: 'PCV', label: 'Passenger Commercial Vehicle' },
  { pattern: /^PCV/i, product: 'PCV', label: 'Passenger Commercial Vehicle' },
  { pattern: /^PCVE/i, product: 'PCV', label: 'Passenger Commercial Vehicle' },
  { pattern: /3W_AUTO/i, product: 'PCV', label: 'Passenger Commercial Vehicle' },
  { pattern: /SCHOOL.?BUS|STAFF.?BUS|School|Staff Bus/i, product: 'PCV', label: 'Passenger Commercial Vehicle' },
  { pattern: /BIG_TAXI|MAXI_CAB/i, product: 'PCV', label: 'Passenger Commercial Vehicle' },
  { pattern: /PCCV/i, product: 'PCV', label: 'Passenger Commercial Vehicle' },
  { pattern: /\bSC\s*[<>]/i, product: 'PCV', label: 'Passenger Commercial Vehicle' },

  // CAR - Private Car / 4-Wheeler
  { pattern: /Private\s*Car/i, product: 'CAR', label: 'Private Car' },
  { pattern: /^PC\b/i, product: 'CAR', label: 'Private Car' },
  { pattern: /^Petrol[<>0-9]/i, product: 'CAR', label: 'Private Car' },
  { pattern: /^Diesel[<>0-9]/i, product: 'CAR', label: 'Private Car' },
  { pattern: /^CNG[<>0-9]/i, product: 'CAR', label: 'Private Car' },
  { pattern: /^\d+\s*TO\s*\d+\s*CC/i, product: 'CAR', label: 'Private Car' },
  { pattern: /^UPTO\s*\d+\s*CC/i, product: 'CAR', label: 'Private Car' },
  { pattern: /^ABOVE\s*\d+\s*CC/i, product: 'CAR', label: 'Private Car' },

  // TW_EV - Two Wheeler Electric
  { pattern: /\d+\s*KW/i, product: 'TW_EV', label: 'Two Wheeler - Electric' },
  { pattern: /LOW_SPEED|HIGH_SPEED/i, product: 'TW_EV', label: 'Two Wheeler - Electric' },

  // TW - Two Wheeler
  { pattern: /Two\s*Wheeler/i, product: 'TW', label: 'Two Wheeler' },
  { pattern: /^MC[_ <>=]/i, product: 'TW', label: 'Two Wheeler' },
  { pattern: /^SC[/_\s]/i, product: 'TW', label: 'Two Wheeler' },
  { pattern: /^SC$/i, product: 'TW', label: 'Two Wheeler' },
  { pattern: /^RE$/i, product: 'TW', label: 'Two Wheeler' },
  { pattern: /^SC_EV/i, product: 'TW', label: 'Two Wheeler' },
  { pattern: /SCOOTER/i, product: 'TW', label: 'Two Wheeler' },
  { pattern: /^\d+cc$/i, product: 'TW', label: 'Two Wheeler' },
  { pattern: /^\d+_\d+cc$/i, product: 'TW', label: 'Two Wheeler' },
  { pattern: /^\d+cc\+?$/i, product: 'TW', label: 'Two Wheeler' },

  // MISC
  { pattern: /^Misc/i, product: 'MISC', label: 'Miscellaneous' },
  { pattern: /Non.?Motor/i, product: 'NON_MOTOR', label: 'Non Motor' },
];

/**
 * Classify product based on segment text.
 * @param {string} segment - The segment/subclass text
 * @param {string} currentProduct - The current product value (fallback)
 * @param {string} sheetName - Original sheet name for additional context
 * @returns {{ product: string, label: string }}
 */
function classifyProduct(segment, currentProduct, sheetName) {
  if (!segment) return { product: currentProduct || 'UNKNOWN', label: currentProduct || 'Unknown' };

  const seg = segment.trim();

  for (const rule of PRODUCT_RULES) {
    if (rule.pattern.test(seg)) {
      return { product: rule.product, label: rule.label };
    }
  }

  // Fallback: use sheet name context.
  //
  // Order matters here: PCV / GCV / CV must be checked BEFORE the
  // private-car heuristic, because sheet names like "4W GCV EV" /
  // "3W PCV Comp" contain "4w" / "3w" tokens that would otherwise pin
  // them to CAR / TW. The CV check covers "GCV", "PCV", "HCV", and
  // bare "CV" (Pan-India CV STP, etc.).
  const sheet = (sheetName || '').toLowerCase();
  if (sheet.includes('taxi') || /\bpcv\b/.test(sheet) || sheet.includes('bus')) return { product: 'PCV', label: 'Passenger Commercial Vehicle' };
  if (/\b(gcv|hcv|gccv)\b/.test(sheet)) return { product: 'GCV', label: 'Goods Commercial Vehicle' };
  if (/\bcv\b/.test(sheet)) return { product: 'GCV', label: 'Goods Commercial Vehicle' };
  if (sheet.includes('tw') || sheet.includes('two wheel')) return { product: 'TW', label: 'Two Wheeler' };
  if (sheet.includes('4w') || sheet.includes('car') || sheet.includes('pc')) return { product: 'CAR', label: 'Private Car' };
  if (sheet.includes('non motor')) return { product: 'NON_MOTOR', label: 'Non Motor' };

  return { product: currentProduct || 'UNKNOWN', label: currentProduct || 'Unknown' };
}

/**
 * Product display names mapping
 */
const PRODUCT_LABELS = {
  'GCV': 'Goods Commercial Vehicle',
  'PCV': 'Passenger Commercial Vehicle',
  'CAR': 'Private Car',
  'TW': 'Two Wheeler',
  'TW_EV': 'Two Wheeler - Electric',
  'MISC': 'Miscellaneous',
  'NON_MOTOR': 'Non Motor',
  'UNKNOWN': 'Unknown',
};

function getProductLabel(product) {
  return PRODUCT_LABELS[product] || product;
}

module.exports = { classifyProduct, getProductLabel, PRODUCT_LABELS };
