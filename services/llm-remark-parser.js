/**
 * LLM-fallback parser for free-text UW remarks.
 *
 * Strategy:
 *   1. Each unique remark string is processed AT MOST ONCE — results cache
 *      to `parsed_remarks_cache` keyed by sha256(remark_text).
 *   2. Cache miss → one call to Claude Haiku with a tight JSON schema.
 *   3. Concurrency capped at 5 so we don't burst the API.
 *   4. enrichRulesWithLlmRemarks() updates rules in-place, only filling
 *      DB columns that the regex pipeline left null (so explicit DB values
 *      always win over LLM guesses).
 *
 * Env: ANTHROPIC_API_KEY (skips silently when unset).
 */

const crypto = require('crypto');
const sql = require('mssql');
const { getPool } = require('../db/connection');

const MODEL = process.env.LLM_REMARKS_MODEL || 'claude-haiku-4-5-20251001';
const API_URL = 'https://api.anthropic.com/v1/messages';
// Free tier is 50 RPM. Sequential + 1.4s spacing keeps us under that
// with safety headroom. Bumps automatically on 429 backoff (see retry).
const CONCURRENCY = 1;
const REQUEST_SPACING_MS = 1400;
const MAX_RETRIES = 4;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const SCHEMA_PROMPT = `You extract structured data from insurance rate-card "UW remarks" cells.
Return ONLY a JSON object. OMIT any field you can't determine — never invent values.

Recognised fields (all optional):
  make_only          : string, comma-separated UPPERCASE make names ("TATA,SML ISUZU") when remarks restrict to specific makes that are ALLOWED. NEVER include makes/models that are DECLINED, EXCLUDED, NOT ALLOWED, or follow "Except"/"Other than" — those go in `make_excluded` instead.
  make_excluded      : string, comma-separated UPPERCASE make/model names ("ALTO,ECCO") when remarks DECLINE or EXCLUDE specific makes/models. Triggered by words like "Decline", "Declined", "Not allowed", "Except", "Excluding", "Other than".
  fuel_only          : "Electric" | "Petrol" | "Diesel" | "CNG" | "LPG" — when remarks say "(CNG ONLY)" / "(Petrol Only)" etc.
  fuel_excluded      : array of strings (any of the above) — when "Except DIESEL" / "Other than Petrol" / "EV Declined" etc.
  age_min, age_max   : integers (years)
  ncb_min, ncb_max   : integers 0-100. "NCB Cases" → 1,99 — "Without NCB" → 0,0
  idv_min, idv_max   : integers (rupees). "IDV upto 10 lacs" → max 1000000
  rto_only           : array of RTO codes ("HR68", "WB02") — when remarks include / allow specific RTOs
  rto_except         : array of RTO codes — when remarks exclude/decline specific RTOs
  cpa                : "Yes" | "No" — for "With CPA policy" / "Without CPA"
  suppress_saod      : true when remarks say "SA-OD not allowed"
  business_type      : "New" | "Renewal" | "Rollover" | "Used"
  zone               : "Zone 1" | "Zone 2" | "Zone 3" etc.
  nil_dep_conditional_rate : number — for "for NIL dep cases payout is X%"
  is_declined        : true when remark fully declines the row

Examples:
"NCB Cases & With CPA policy & new vehicles" → {"ncb_min":1,"ncb_max":99,"cpa":"Yes","age_min":0,"age_max":0,"business_type":"New"}
"TATA & SML ISUZU (CNG ONLY) (UPTO 15 YEARS)" → {"make_only":"TATA,SML ISUZU","fuel_only":"CNG","age_min":0,"age_max":15}
"RTO HR 68 IS ALLOWED" → {"rto_only":["HR68"]}
"Except RTO Codes MP-06,07,09,10,13,15,28,41,46,50,68." → {"rto_except":["MP06","MP07","MP09","MP10","MP13","MP15","MP28","MP41","MP46","MP50","MP68"]}
"IDV upto 10 lacs only" → {"idv_max":1000000}
"OLD" → {"business_type":"Used"}
"ZONE 2" → {"zone":"Zone 2"}
"Tractor is only new and without trailer" → {"business_type":"New"}
"Excluding Tankers" → {}   (sub-type exclusions go in remarks, not a structured field)
"SC upto (3+1)" → {}        (THIS IS SEATING CAPACITY (3 passenger + 1 driver = 4 seats), NOT NCB. Do NOT extract anything for SC/(N+1) patterns — leave as {}.)
"without NCB cases only & IDV upto 15 lacs only. Alto & ECCO Decline" → {"ncb_min":0,"ncb_max":0,"idv_max":1500000,"make_excluded":"ALTO,ECCO"}
"Only HONDA & HYUNDAI manufacture only. SWIFT Decline" → {"make_only":"HONDA,HYUNDAI","make_excluded":"SWIFT"}

CRITICAL: NCB fields (ncb_min/ncb_max) MUST only be extracted when the remark text literally contains the letters "NCB". Never extract NCB from seating capacity patterns like "(3+1)", "(6+1)", "5+1", or generic "+1" notations.

Return ONLY the JSON object. No prose, no code fences.`;

function hashRemark(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

/** POST one remark to Claude Haiku. Retries 429 with exponential backoff.
 *  Throws on persistent failure; never returns null. */
async function callLlm(remark) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `${SCHEMA_PROMPT}\n\nNow extract from this remark (return JSON only, no prose):\n"""${remark}"""`,
    }],
  });
  let attempt = 0;
  while (true) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body,
    });
    if (res.status === 429) {
      // Rate-limited — back off and retry. Honour Retry-After header when present.
      if (attempt >= MAX_RETRIES) {
        throw new Error(`Anthropic API 429 after ${attempt} retries (rate-limited)`);
      }
      const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10);
      const wait = retryAfter > 0 ? retryAfter * 1000 : Math.min(30000, 2000 * Math.pow(2, attempt));
      console.log(`[llm-remarks] 429 — backing off ${wait}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(wait);
      attempt++;
      continue;
    }
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Anthropic API ${res.status}: ${txt.slice(0, 200)}`);
    }
    const data = await res.json();
    const text = (data.content && data.content[0] && data.content[0].text || '').trim();
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    try { return JSON.parse(cleaned); }
    catch (e) {
      console.warn('[llm-remarks] non-JSON reply:', cleaned.slice(0, 120));
      return null;
    }
  }
}

/** Look up cached extract for a remark; null on miss. */
async function cacheLookup(pool, hash) {
  const r = await pool.request()
    .input('hash', sql.Char(64), hash)
    .query('SELECT TOP 1 json_extract FROM parsed_remarks_cache WHERE remark_hash = @hash');
  if (r.recordset.length === 0) return null;
  try { return JSON.parse(r.recordset[0].json_extract); } catch { return null; }
}

async function cacheStore(pool, hash, remark, extract) {
  try {
    await pool.request()
      .input('hash',  sql.Char(64), hash)
      .input('text',  sql.NVarChar(sql.MAX), String(remark))
      .input('json',  sql.NVarChar(sql.MAX), JSON.stringify(extract || {}))
      .input('model', sql.VarChar(100), MODEL)
      .query(`INSERT INTO parsed_remarks_cache (remark_hash, remark_text, json_extract, model)
              VALUES (@hash, @text, @json, @model)`);
  } catch (e) { /* unique-index race / dup — ignore */ }
}

/** Bounded-concurrency worker pool. */
async function runConcurrent(items, limit, fn) {
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
}

/**
 * Enrich an array of rate_rule objects in-place. For each distinct
 * non-empty `remarks` value, fetch the LLM extract (cache or live) and
 * fill DB columns that the regex engine left null/blank.
 *
 * Safe no-op when ANTHROPIC_API_KEY is unset.
 */
async function enrichRulesWithLlmRemarks(rules) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('[llm-remarks] ANTHROPIC_API_KEY not set — skipping enrichment');
    return { enriched: 0, llm_calls: 0, cache_hits: 0 };
  }
  if (!Array.isArray(rules) || rules.length === 0) return { enriched: 0, llm_calls: 0, cache_hits: 0 };

  // Collect distinct remarks.
  const distinct = new Set();
  for (const r of rules) {
    const rmk = String(r.remarks || '').trim();
    if (rmk) distinct.add(rmk);
  }
  if (distinct.size === 0) return { enriched: 0, llm_calls: 0, cache_hits: 0 };

  const pool = await getPool();
  const extracts = new Map(); // remark → extract obj
  const items = [...distinct].map(rmk => ({ rmk, hash: hashRemark(rmk) }));

  let llmCalls = 0, cacheHits = 0, llmFailures = 0;
  await runConcurrent(items, CONCURRENCY, async ({ rmk, hash }) => {
    const cached = await cacheLookup(pool, hash);
    if (cached !== null) { extracts.set(rmk, cached); cacheHits++; return; }
    try {
      const extract = await callLlm(rmk);
      llmCalls++;
      const safe = extract && typeof extract === 'object' ? extract : {};
      // Only cache SUCCESSFUL extractions so transient failures can retry
      // on the next upload instead of being baked in as empty extracts.
      await cacheStore(pool, hash, rmk, safe);
      extracts.set(rmk, safe);
    } catch (e) {
      llmFailures++;
      console.warn('[llm-remarks] LLM call failed for "%s": %s', rmk.slice(0, 60), e.message);
      extracts.set(rmk, {}); // use empty for this run; don't cache
    }
    // Spacing — stay under the 50 RPM free-tier ceiling. Skipped when
    // CONCURRENCY > 1 (paid tier).
    if (CONCURRENCY === 1) await sleep(REQUEST_SPACING_MS);
  });

  // Merge extracts into rules — only fill blanks; never overwrite regex values.
  let enriched = 0;
  for (const r of rules) {
    const rmk = String(r.remarks || '').trim();
    if (!rmk) continue;
    const ex = extracts.get(rmk);
    if (!ex || typeof ex !== 'object') continue;

    let changed = false;
    if ((!r.make || r.make === '') && ex.make_only) {
      // Guard: drop any make_only token that also appears in the
      // remark immediately followed by "Decline"/"Declined"/"Not
      // allowed". The LLM occasionally lumps DECLINED models into
      // make_only (e.g. "Alto & ECCO Decline" → make_only:"ALTO,ECCO").
      const rmkUp = rmk.toUpperCase();
      const declineRe = /\b([A-Z][A-Z0-9]+(?:\s+[A-Z][A-Z0-9]+)?)\s*(?:&|AND|,)?\s*(?:[A-Z][A-Z0-9]+(?:\s+[A-Z][A-Z0-9]+)?)?\s*(?:DECLINE[DS]?|NOT\s+ALLOWED|EXCLUDED?)/g;
      const declinedSet = new Set();
      // Cheap precheck — only run the heavy scan when relevant keywords are present.
      if (/\b(DECLINE|NOT\s+ALLOWED|EXCLUD)/i.test(rmkUp)) {
        // Capture every uppercase token within ~80 chars before "Decline"/etc.
        for (const m of rmkUp.matchAll(/((?:[A-Z][A-Z0-9]+(?:\s*(?:&|AND|,)\s*[A-Z][A-Z0-9]+)*))\s+(?:DECLINE[DS]?|NOT\s+ALLOWED|EXCLUDED?)/g)) {
          for (const tok of m[1].split(/\s*(?:,|&|\bAND\b)\s*/i)) {
            const t = tok.trim();
            if (t) declinedSet.add(t);
          }
        }
      }
      const cleaned = String(ex.make_only).toUpperCase()
        .split(/\s*,\s*/)
        .filter(m => m && !declinedSet.has(m));
      if (cleaned.length > 0) {
        r.make = cleaned.join(',');
        changed = true;
      }
    }
    if ((!r.fuel_type || r.fuel_type === '') && ex.fuel_only) {
      r.fuel_type = ex.fuel_only;
      changed = true;
    }
    if (r.vehicle_age_min == null && Number.isFinite(ex.age_min)) {
      r.vehicle_age_min = ex.age_min;
      changed = true;
    }
    if (r.vehicle_age_max == null && Number.isFinite(ex.age_max)) {
      r.vehicle_age_max = ex.age_max;
      changed = true;
    }
    if (r.discount_pct == null && Number.isFinite(ex.idv_min)) { /* IDV is export-side */ }
    if (changed) enriched++;
  }

  console.log(`[llm-remarks] cache_hits=${cacheHits} llm_calls=${llmCalls} llm_failures=${llmFailures} enriched_rules=${enriched}`);
  return { enriched, llm_calls: llmCalls, llm_failures: llmFailures, cache_hits: cacheHits };
}

module.exports = {
  enrichRulesWithLlmRemarks,
  hashRemark,
  callLlm,    // exported for ad-hoc testing
};
