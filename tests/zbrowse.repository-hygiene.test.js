const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);
const installer = fs.readFileSync(path.join(root, 'zbrowse/scripts/install.sh'), 'utf8');

assert.ok(ignore.includes('.env'), 'local .env files must remain ignored');
assert.ok(ignore.includes('.env.local'), 'local .env.local files must remain ignored');
assert.ok(ignore.includes('.env.*.local'), 'named local env overrides must remain ignored');
assert.match(
  installer,
  /cp \.env\.example \.env/,
  'zBrowse installer is expected to materialize a local .env from the tracked example'
);
assert.ok(
  fs.existsSync(path.join(root, 'zbrowse/.env.example')),
  'tracked zBrowse environment example must remain present'
);

console.log('zBrowse environment hygiene contract passed');
