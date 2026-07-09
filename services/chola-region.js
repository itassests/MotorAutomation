// Chola region resolution from the authoritative June RTO reference
// (config/chola_rto_cluster.json, built from "Chola RTO & Guidelines.xlsx").
//
// Chola's CV/tractor grids use a small set of special clusters that a plain
// state-prefix can't distinguish:
//   • Maharashtra  → "Mumbai/GA/Pune/Central MH" for the Mumbai/Pune/Central-MH
//                    RTOs in the reference; every OTHER MH RTO → "ROM".
//   • Tamil Nadu   → "TN-Chennai" for the Chennai RTOs; every OTHER TN → "ROTN".
//   • Uttar Pradesh→ "UP- East" for the East-UP district codes; other UP → "UP".
// Other states have no such split, so this returns null and the caller keeps its
// existing prefix mapping.

const path = require('path');
let CFG = null;
function cfg() {
  if (!CFG) { try { CFG = require(path.join(__dirname, '..', 'config', 'chola_rto_cluster.json')); }
              catch (_) { CFG = { mh_cluster: {}, tn_chennai: [], up_east: [] }; } }
  return CFG;
}
function norm(code) { return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

// Returns the corrected Chola grid region for MH / TN / UP RTOs, or null when the
// state has no special split (caller falls back to its own prefix map).
function cholaRegion(rtoCode) {
  const c = norm(rtoCode);
  const pre = c.slice(0, 2);
  const g = cfg();
  if (pre === 'MH') return g.mh_cluster[c] ? 'Mumbai/GA/Pune/Central MH' : 'ROM';
  if (pre === 'TN') return g.tn_chennai.includes(c) ? 'TN-Chennai' : 'ROTN';
  if (pre === 'UP') return g.up_east.includes(c) ? 'UP- East' : 'UP';
  return null;
}

module.exports = { cholaRegion };
