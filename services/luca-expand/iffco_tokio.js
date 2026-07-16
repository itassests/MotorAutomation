// ---------------------------------------------------------------------------
// IFFCO Tokio — luca export expander.
//
// OUTCOME OF AUDIT: SUPPRESS-ONLY. No rates are expanded. Read why before
// adding any.
//
// 1) IFFCO IS NOT A CONFIG-DRIVEN RESOLVER INSURER.
//    There is no services/iffco-*.js resolver. routes/bulk.js resolves IFFCO
//    entirely out of the rate_rules DB table via lookupRates() — its three
//    IFFCO blocks (MISC→GCV middle-slab override ~L2364, TW state/slab
//    override ~L2412, PCV decline last-resort ~L6234) only seed a REGION from
//    the RTO state and pick a slab/cover; every rate they return comes from a
//    DB row. So there is nothing here for a config expander to mirror.
//
// 2) config/iffco-rates.json IS A PARSER CACHE, NOT A CALCULATION CONFIG.
//    Its only reader is parsers/engines/iffco.js (RATES_CACHE_FILE, L39) —
//    grep confirms nothing at calculation time ever loads it. It exists so an
//    xlsx upload can reuse the numbers OCR'd from a previously-uploaded PDF.
//    Expanding it would publish rates the engine never pays — precisely the
//    failure this pipeline exists to prevent.
//
// 3) ITS NUMBERS ARE NOT PROVABLY THE JUNE GRID.
//    parsePdfFile() starts from a deep clone of DEFAULT_RATES and only
//    overwrites a key when an OCR regex matches; loadRates() likewise merges
//    the cache OVER defaults. The cached values are byte-identical to the
//    hardcoded FY26-27 April DEFAULT_RATES, so a successful June extraction
//    and a silent fall-through to defaults are indistinguishable. Unverifiable.
//
// 4) THE SHAPE IS WRONG ANYWAY.
//    iffco-rates.json holds flat pan-India base rates. The real grid — and what
//    the engine actually pays — is per-STATE (card 424 'RTO Comp'/'TP' sheets,
//    3,843 rows) with Red/declined states at 0, state groups and GWP slabs.
//    Emitting e.g. a pan-India "TW COMP 17.5%" row would be flatly WRONG for
//    the Red states (AS, MP, CG, RJ, UP, Rest-MH, KA, TN, KL) that pay 0.
//
// WHY THE FILE SHOWS EXACTLY ONE IFFCO ROW
//    IFFCO ingests in TWO steps: the PDF writes only a placeholder marker row
//    ("[META] … Now upload iffco_rto.xlsx to generate rate rules"), and the
//    companion 'iffco rto.xlsx' upload writes the actual per-state rules.
//    For the June generation ONLY STEP ONE HAPPENED:
//      card 544  1-Jun-2026  'May Motor and Retail Health.pdf'  → 1 META row
//      card 424  1-Apr-2026  'iffco rto.xlsx' → 3,843 real rules, but
//                            effective_to = 1-Jun-2026 (expired)
//    The export's active-card window (effective_to > today) therefore admits
//    card 544 alone, and its lone META row is the single rule reaching the file.
//
// WHAT THAT ROW LOOKS LIKE TO AN AGENT
//    product 'META', segment 'IFFCO Rate Reference', rate_value 0. It is a
//    pipeline placeholder, not a rate — but the export does not know that:
//    inferVehicleType() reads it as 'MIS' and inferProduct() as 'Comp', so the
//    agent's file renders "IFFCO Tokio / Miscellaneous / Comprehensive / 0%" —
//    a fabricated pan-India decline for a class IFFCO does in fact rate.
//    Suppressing it makes IFFCO ABSENT from the file, which is the correct and
//    honest outcome: absent is recoverable, a phantom 0% is acted upon.
//
// TO RESTORE IFFCO PROPERLY (needs an operator, not code)
//    Upload the June 'iffco rto.xlsx' companion against the June card so the
//    per-state rules ingest. No expander should be written from the base-rate
//    cache to paper over the missing upload.
// ---------------------------------------------------------------------------

/**
 * The PDF-upload placeholder marker row (parsers/engines/iffco.js parsePdfFile).
 * Matched on its stable identity — product/rate_type 'META' + the fixed segment
 * literal — because sheet_name is a per-upload timestamped filename
 * ("1782136197138_May__Motor__and__Retail__Health.pdf") that changes every time
 * the PDF is re-uploaded. Belt-and-braces: rate_value must be the placeholder 0,
 * so a real rate could never be caught by this. Scoped to iffco_tokio by
 * isSuppressed() before this predicate ever runs.
 */
function isMetaPlaceholder(row) {
  const seg = String(row.segment || '').trim().toUpperCase();
  const rt = String(row.rate_type || '').trim().toUpperCase();
  const prod = String(row.product || '').trim().toUpperCase();
  return prod === 'META'
    && rt === 'META'
    && seg === 'IFFCO RATE REFERENCE'
    && Number(row.rate_value) === 0;
}

module.exports = {
  insurer: 'iffco_tokio',

  // Drop the placeholder. Nothing else: the per-state rules on card 424 are
  // genuine ingested grid data and are NOT overridden by any resolver — they are
  // simply out of the export's date window. Suppression must never reach them.
  suppress: [isMetaPlaceholder],

  // Deliberately empty — see (1)-(4) above. NEVER expand config/iffco-rates.json:
  // it is a parser cache of unverifiable flat base rates, not the per-state grid
  // the engine pays from.
  expand: () => [],
};
