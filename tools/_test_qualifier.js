// Direct unit-test of parseYearDepQualifier via the engine module.
// We re-require the file and re-eval the function locally because the
// engine doesn't export it.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'parsers', 'engines', 'pivot-by-city.js'), 'utf8');
const fnSrc = src.match(/function parseYearDepQualifier[\s\S]*?\n\}\n/)[0];
const expandSrc = src.match(/function expandMakeAbbreviations[\s\S]*?\n\}\n/)[0];
const fn = new Function(expandSrc + '\n' + fnSrc + '\nreturn parseYearDepQualifier;')();

const cases = [
  'Up to 5 years without Nil Dep',
  'Upto 5 Year',
  'Upto 5 Years',
  'Up to 5 years with or without Nil Dep',
  'All Years with Nil Dep',
  'All Years without Nil Dep',
  '5 Years & Above',
  'Above 5 Years',
  'Brand New',
  '40 to 45 (AL)',
  '40 to 45 (Eicher)',
  'Other than TATA & AL',
  'All Makes',
];
for (const c of cases) {
  console.log(`"${c}":`, JSON.stringify(fn(c)));
}
