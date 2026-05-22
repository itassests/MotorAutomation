/**
 * Calculate payout amounts from matched rate rules and premium inputs.
 *
 * Key concept: CD1 = Discount (max allowed by insurer on OD premium)
 *              CD2 = Rate/Payout (commission earned at that discount level)
 * They are linked — CD1 is a parameter that determines the CD2 payout.
 *
 * @param {Array<object>} rules - Matched rate rules from lookupRates
 * @param {object} premiums - { od_premium, tp_premium, addon_premium }
 * @param {object} [context] - Optional: { vehicle_age, discount_pct }
 * @returns {{ rules_matched, discount_info, payout_breakdown, total_payout }}
 */
function calculatePayout(rules, premiums, context = {}) {
  const { od_premium = 0, tp_premium = 0, addon_premium = 0, net_premium = 0 } = premiums;
  const { discount_pct, vehicle_type, ins_product } = context;

  // Premium-base policy:
  //   GCV / PCV / MISC          → Net premium (OD + TP + Addon) for every rule.
  //   CAR / TW (and others)     → OD + Addon for Comp & SAOD, TP for TP-only.
  // This overrides the rate_type-specific heuristic in determinePremium() for
  // everything we've explicitly mapped; fallback to that helper only when
  // neither vehicle_type nor ins_product is known.
  const vt = String(vehicle_type || '').toUpperCase();
  const ip = String(ins_product || '').toUpperCase();
  const useNetPremiumBase = ['GCV', 'PCV', 'MISC'].includes(vt);
  function pickPremiumBase(rateType) {
    if (useNetPremiumBase) {
      return net_premium || (od_premium + tp_premium + addon_premium);
    }
    // CAR / TW / other passenger vehicles — base depends on insurance product
    if (ip === 'TP') return tp_premium;
    if (ip === 'COMP' || ip === 'SAOD') return od_premium + addon_premium;
    // Unknown ins_product → fall back to rate_type-based heuristic
    return determinePremium(rateType, od_premium, tp_premium, addon_premium);
  }

  // Separate CD1 (discount) and CD2 (payout rate) rules
  const cd1Rules = [];
  const cd2Rules = [];

  for (const rule of rules) {
    if (rule.is_declined) continue;
    const category = classifyRateType(rule.rate_type);
    if (category === 'CD1') {
      cd1Rules.push(rule);
    } else {
      cd2Rules.push(rule);
    }
  }

  // Build discount info from CD1 rules
  const discountInfo = cd1Rules.map(r => {
    let rateValue = parseFloat(r.rate_value) || 0;
    if (r.is_conditional && r.conditional_rates && r.conditional_rates.length > 0) {
      const resolved = resolveConditionalRate(r.conditional_rates, context);
      if (resolved != null) rateValue = resolved;
    }
    // Normalize: if rate > 1, it's stored as a whole percentage
    if (rateValue > 1) rateValue = rateValue / 100;
    return {
      rule_id: r.id,
      rate_type: r.rate_type,
      max_discount: rateValue,
      max_discount_pct: (rateValue * 100).toFixed(1) + '%',
      segment: r.segment,
      region: r.region,
    };
  });

  // Determine effective discount
  let effectiveDiscount = null;
  let discountSource = null;

  if (discount_pct != null) {
    // User specified a discount percentage
    effectiveDiscount = discount_pct / 100;
    discountSource = 'user_input';
  } else if (cd1Rules.length > 0) {
    // Use the max CD1 discount as default
    effectiveDiscount = Math.max(...discountInfo.map(d => d.max_discount));
    discountSource = 'cd1_max';
  }

  // Calculate net OD premium after discount
  const netOD = effectiveDiscount != null
    ? od_premium * (1 - effectiveDiscount)
    : od_premium;

  // Discount validation
  let discountValid = true;
  let discountWarning = null;
  if (discount_pct != null && discountInfo.length > 0) {
    const maxAllowed = Math.max(...discountInfo.map(d => d.max_discount));
    if (effectiveDiscount > maxAllowed) {
      discountValid = false;
      discountWarning = `Discount ${discount_pct}% exceeds max allowed ${(maxAllowed * 100).toFixed(1)}%`;
    }
  }

  // Calculate payout from CD2 (rate) rules
  const breakdown = [];
  let totalPayout = 0;

  for (const rule of cd2Rules) {
    let rateValue = parseFloat(rule.rate_value) || 0;

    if (rule.is_conditional && rule.conditional_rates && rule.conditional_rates.length > 0) {
      const resolved = resolveConditionalRate(rule.conditional_rates, context);
      if (resolved != null) rateValue = resolved;
    }

    // Normalize: if rate > 1, it's stored as a whole percentage (e.g. 24.5 = 24.5%)
    if (rateValue > 1) rateValue = rateValue / 100;

    const premiumApplied = pickPremiumBase(rule.rate_type);
    const payoutAmount = premiumApplied * rateValue;

    breakdown.push({
      rule_id: rule.id,
      rate_type: rule.rate_type,
      category: 'Rate (CD2)',
      rate_value: rateValue,
      premium_applied: premiumApplied,
      payout_amount: Math.round(payoutAmount * 100) / 100,
      region: rule.region,
      segment: rule.segment,
    });

    totalPayout += payoutAmount;
  }

  return {
    rules_matched: rules.length,
    discount_info: {
      cd1_rules: discountInfo,
      effective_discount: effectiveDiscount,
      effective_discount_pct: effectiveDiscount != null ? (effectiveDiscount * 100).toFixed(1) + '%' : null,
      discount_source: discountSource,
      discount_valid: discountValid,
      discount_warning: discountWarning,
      net_od_premium: Math.round(netOD * 100) / 100,
    },
    payout_breakdown: breakdown,
    total_payout: Math.round(totalPayout * 100) / 100,
  };
}

/**
 * Classify a rate_type as CD1 (discount) or CD2 (rate/payout).
 */
function classifyRateType(rateType) {
  if (!rateType) return 'CD2';
  const rt = rateType.toUpperCase();

  // CD1 types = Discount (must explicitly contain "CD1" or be a known discount type)
  if (rt === 'CD1' ||
      rt.includes('CD1') ||
      rt.startsWith('FLEXI')) {
    return 'CD1';
  }

  return 'CD2';
}

/**
 * Determine which premium amount to apply based on rate_type.
 */
function determinePremium(rateType, odPremium, tpPremium, addonPremium) {
  if (!rateType) return 0;

  const rt = rateType.toUpperCase();

  // TP / ACT / SATP types apply to TP premium
  if (rt.includes('TP') || rt.includes('ACT') || rt.includes('SATP')) {
    return tpPremium;
  }

  // MAX_CD2 applies to OD + addon
  if (rt === 'MAX_CD2' || rt.includes('MAX_CD2')) {
    return odPremium + addonPremium;
  }

  // OD / SAOD / COMP / PACK types apply to OD + addon
  if (rt.includes('OD') || rt.includes('SAOD') || rt.includes('COMP') || rt.includes('PACK')) {
    return odPremium + addonPremium;
  }

  // Default: OD premium
  return odPremium;
}

/**
 * Pick the correct conditional rate value based on context (e.g. vehicle_age).
 */
function resolveConditionalRate(conditionalRates, context) {
  const { vehicle_age } = context;

  if (vehicle_age != null) {
    for (const cr of conditionalRates) {
      const minOk = cr.condition_min == null || vehicle_age >= cr.condition_min;
      const maxOk = cr.condition_max == null || vehicle_age <= cr.condition_max;
      if (minOk && maxOk) {
        return parseFloat(cr.rate_value);
      }
    }
  }

  if (context.condition_type) {
    for (const cr of conditionalRates) {
      if (cr.condition_type === context.condition_type) {
        return parseFloat(cr.rate_value);
      }
    }
  }

  return null;
}

module.exports = { calculatePayout, determinePremium, resolveConditionalRate, classifyRateType };
