/**
 * ICICI CV sub-cluster (GJ1/GJ2/AP1/…) resolver.
 *
 * ICICI's CV grid prices several cells by an RTO SUB-CLUSTER that the ingestion
 * stored in the rate_rule `make` column (e.g. make="GJ1" → 0.55, make="GJ2" →
 * 0.45, make="" → OTHERS 0). The sub-cluster itself is defined per
 * (segment-band, RTO-city, make-category) in the cluster master
 * "Lombard CVRTOCluster-RTOGroup.xlsx" — captured here as config/icici_cv_zone.json,
 * with RTO→city in config/icici_rto_city.json.
 *
 * resolveIciciSubCluster(params) → 'GJ1' | 'GJ2' | … | null (null = couldn't
 * resolve; caller leaves matching unchanged). The policy.js make-gate then keeps
 * the rate row whose make === resolved sub-cluster (or the make="" OTHERS fallback).
 */
let ZONE = null, RTO_CITY = null, ZONE_ALT = null;
// Connector-insensitive city form: drop the literal "AND" token so the RTO
// master's spelling ("DADRANAGARHAVELI", "DAMANDIU") joins the cluster file's
// ("DADRAANDNAGARHAVELI", "DAMANANDDIU"). Applied to BOTH sides, so even an
// accidental mid-word strip transforms identically and still matches.
const andless = s => String(s || '').replace(/AND/g, '');
function load() {
  if (ZONE) return;
  try { ZONE = require('../config/icici_cv_zone.json'); } catch (_) { ZONE = {}; }
  try { RTO_CITY = require('../config/icici_rto_city.json'); } catch (_) { RTO_CITY = {}; }
  // Build an AND-stripped alias index (fallback only; original keys win).
  ZONE_ALT = {};
  for (const k in ZONE) {
    const i1 = k.indexOf('|'), i2 = k.indexOf('|', i1 + 1);
    if (i1 < 0 || i2 < 0) continue;
    const city = k.slice(i1 + 1, i2), alt = andless(city);
    if (alt === city) continue;
    const ak = k.slice(0, i1 + 1) + alt + k.slice(i2);
    if (ZONE_ALT[ak] === undefined) ZONE_ALT[ak] = ZONE[k];
  }
}

const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// RTO-code padding variants: bulk may pass the unpadded form (DD1, GJ8) it used
// for the rto_mapping lookup, while RTO_CITY is keyed by the master's padded
// spelling (DD01, GJ08). Try both so the zone join survives either form.
function rtoVariants(code) {
  const c = norm(code);
  const m = c.match(/^([A-Z]+)(\d+)$/);
  if (!m) return [c];
  const letters = m[1], n = parseInt(m[2], 10);
  const out = [c, letters + n, letters + String(n).padStart(2, '0')];
  return [...new Set(out)];
}

// (make, model, vehicleType) → the cluster-master make-category bucket.
function makeCategory(make, model, vt) {
  const m = (String(make || '') + ' ' + String(model || '')).toUpperCase();
  const isTata = /\bTATA\b|TATAMOTORS/.test(m);
  const isMM   = /MAHINDRA|\bM\s*&\s*M\b|\bM&M\b/.test(m);
  if (isMM) {
    // Bolero Pik-Up / Camper / Supro = the classic small-CV bucket. Bolero MAXX
    // (and Bolero Maxi / Maxx Pik-Up — a separate newer model) → OTHERS.
    if (/\bMAXX\b|\bMAXI\b/.test(m)) return 'M&M-OTHERS';
    if (/BOLERO|SUPRO/.test(m)) return 'M&M-BOLERO&SUPRO';
    if (/JEETO/.test(m)) return 'M&M-JEETO';
    return 'M&M-OTHERS';
  }
  if (isTata) {
    if (/\bACE\b|MAGIC|INTRA|YODHA/.test(m)) return 'TATAMOTORS-ACE';
    return 'TATAMOTORS-OTHERS';
  }
  if (/MARUTI|SUZUKI/.test(m)) return 'MARUTI';
  if (/ASHOK|LEYLAND/.test(m)) return 'ASHOKLEYLAND';
  if (/EICHER/.test(m)) return 'EICHERMOTOR-DIESEL';
  return 'SCV-OTHERS';
}

// (vehicleType, tonnage) → the cluster-master segment band-key (GCV weight bands only;
// returns null for bands we don't confidently map → caller leaves matching unchanged).
function bandKey(vt, tonnage) {
  const v = String(vt || '').toUpperCase();
  if (v !== 'GCV') return null;
  const t = Number(tonnage);
  if (!Number.isFinite(t) || t <= 0) return null;
  if (t <= 2.45) return 'GCVGVW~LE~35TON~LE~2450KG';
  if (t <= 3.5)  return 'GCVGVW~LE~35TON~GT~2450KG';
  // Heavier bands are body-typed in the master (TRUCK/TIPPER/TANKER/…) — not mapped
  // here; the zone-conditional cells in scope are the SCV (<=3.5T) bands.
  return null;
}

function resolveIciciSubCluster(params) {
  load();
  const bk = bandKey(params.vehicleType, params.tonnage);
  if (!bk) return null;
  const cat = makeCategory(params.make, params.model, params.vehicleType);
  const cities = [];
  for (const v of rtoVariants(params.rtoCode)) {
    if (RTO_CITY[v]) for (const c of RTO_CITY[v]) if (!cities.includes(c)) cities.push(c);
  }
  for (const city of cities) {
    const sub = ZONE[bk + '|' + city + '|' + cat];
    if (sub) return sub;
  }
  // Connector-insensitive retry (handles "DADRANAGARHAVELI" ↔ "DADRAANDNAGARHAVELI").
  for (const city of cities) {
    const sub = ZONE_ALT[bk + '|' + andless(city) + '|' + cat];
    if (sub) return sub;
  }
  return null;
}

// Is a rate_rule `make` value actually a sub-cluster code (e.g. GJ1, AP2) rather
// than a real make? Two letters + digits, no spaces.
const SUBCLUSTER_RE = /^[A-Z]{2,4}\d+$/;
function isSubClusterCode(make) {
  return SUBCLUSTER_RE.test(String(make || '').trim().toUpperCase());
}

module.exports = { resolveIciciSubCluster, makeCategory, isSubClusterCode };
