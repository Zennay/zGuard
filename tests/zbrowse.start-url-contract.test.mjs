import assert from 'node:assert/strict';
import fs from 'node:fs';

const server = fs.readFileSync(new URL('../zbrowse/gateway/server.js', import.meta.url), 'utf8');

assert.match(
  server,
  /const authority = url\.href\.slice\(url\.protocol\.length \+ 2\)\.split\(\/\[\/\?#\]\/\, 1\)\[0\];/,
  'start URL validation must isolate the normalized authority'
);
assert.match(
  server,
  /if \(authority\.includes\("@“?\)\) return null;/,
  'start URL validation must reject userinfo markers in the authority'
);

console.log('zBrowse start URL authority contract passed');
