// Repro the client-side tonnage filter against the actual server response
// for "digit GCV TATA MH06 0-2T comp"
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const http = require('http');
function post(body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: 'localhost', port: 3100, path: '/api/rates/lookup', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => resolve(JSON.parse(chunks)));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}
(async () => {
  const r = await post({ insurer: 'go_digit', product: 'GCV', make: 'TATA', rto_code: 'MH06', ins_product: 'Comp' });
  console.log('total rules:', r.rules_count);
  const tonMin = 0, tonMax = 2;
  const overlap = (pMin, pMax, rMin, rMax) => {
    if (pMin == null && pMax == null) return true;
    if (rMin == null && rMax == null) return true;
    const pLo = pMin != null ? pMin : -Infinity;
    const pHi = pMax != null ? pMax :  Infinity;
    const rLo = rMin != null ? rMin : -Infinity;
    const rHi = rMax != null ? rMax :  Infinity;
    return !(pHi < rLo || pLo > rHi);
  };
  let kept = 0, droppedNoBand = 0, droppedNoOverlap = 0;
  const sheetCounts = {};
  for (const x of r.rules) {
    const rMin = x.weight_band_min != null ? parseFloat(x.weight_band_min) : null;
    const rMax = x.weight_band_max != null ? parseFloat(x.weight_band_max) : null;
    if (rMin == null && rMax == null) { droppedNoBand++; continue; }
    if (!overlap(tonMin, tonMax, rMin, rMax)) { droppedNoOverlap++; continue; }
    kept++;
    sheetCounts[x.sheet_name] = (sheetCounts[x.sheet_name] || 0) + 1;
  }
  console.log('after 0-2T filter:');
  console.log('  kept:', kept);
  console.log('  dropped (no weight band):', droppedNoBand);
  console.log('  dropped (range mismatch):', droppedNoOverlap);
  console.log('  by sheet:', sheetCounts);
})();
