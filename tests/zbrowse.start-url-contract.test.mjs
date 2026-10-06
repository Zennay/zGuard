import assert from 'node:assert/strict';
import fs from 'node:fs';

const server = fs.readFileSync(new URL('../zbrowse/gateway/server.js', import.meta.url), 'utf8');

assert.ok(
  server.includes('const authority = url.href.slice(url.protocol.length + 2).split(/[/?#]/, 1)[0];'),
  'start URL validation must isolate the normalized authority'
);
assert.ok(
  server.includes('if (authority.includes("@")) return null;'),
  'start URL validation must reject userinfo markers in the authority'
);

const sites = JSON.parse(
  fs.readFileSync(new URL('../zbrowse/gateway/config/sites.json', import.meta.url), 'utf8')
);
for (const site of sites) {
  const url = new URL(site.url);
  const authority = url.href.slice(url.protocol.length + 2).split(/[/?#]/, 1)[0];
  assert.ok(!authority.includes('@'), `${site.name}: configured site authority must not contain userinfo`);
}

console.log('zBrowse start URL authority contract passed');
