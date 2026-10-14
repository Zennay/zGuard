// Offline source check for the executed Chrome-for-Testing installation.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync(
  new URL('../.github/workflows/zbrowse-real-chromium-portal.yml', import.meta.url), 'utf8'
);

function validate(source) {
  const start = source.indexOf('- name: Install immutable Chrome for Testing');
  const finish = source.indexOf('- name: Exercise shipped TV portal inside real Chromium', start);
  assert.ok(start > 0 && finish > start, 'real Chrome installation step must remain inspectable');
  const install = source.slice(start, finish);
  const curl = install.split(/\r?\n/).find(line => /^\s*curl\s/.test(line));
  assert.ok(curl, 'Chrome acquisition must execute a literal curl command');
  for (const flag of [
    '--fail', '--show-error', '--location', '--http1.1', '--retry-all-errors',
    '--retry 4', '--retry-delay 2', '--connect-timeout 15', '--max-time 150'
  ]) {
    assert.ok(curl.includes(flag), 'reviewed Chrome acquisition flag missing: ' + flag);
  }
  assert.doesNotMatch(curl, /--insecure|--no-check-certificate/,
    'transport resilience must not weaken TLS verification');
  assert.ok(install.includes('CHROME_VERSION=155.0.8059.39'),
    'reviewed Chrome version must remain pinned');
  assert.ok(install.includes('chrome-for-testing-public/'), 'Chrome artifact host must remain reviewed');
  assert.ok(install.includes('55672d1f392fd3e7b7a08621b6e804e6bcb39d40cf155504abb74b3a021ea8ea'),
    'immutable Chrome checksum must remain unchanged');
  const verify = install.indexOf('sha256sum --check --status');
  const unpack = install.indexOf('unzip -q "$RUNNER_TEMP/chrome-for-testing.zip"');
  assert.ok(verify > 0 && unpack > verify, 'SHA256 must be verified before unpack');
  assert.ok(source.includes('persist-credentials: false') &&
    source.includes('test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"'),
    'browser installation workflow must retain exact HEAD verification');
  assert.ok(source.includes('node tests/zbrowse.portal-chrome-download-integrity.test.mjs'),
    'Chrome acquisition regression must execute in actual hosted browser job');
}
validate(workflow);

for (const [name, old, replacement] of [
  ['HTTP/1.1 transport', '--http1.1', '--http2'],
  ['retry interrupted stream', '--retry-all-errors', '--retry-connrefused'],
  ['retry count', '--retry 4', '--retry 0'],
  ['download limit', '--max-time 150', '--max-time 0'],
  ['checksum verification', 'sha256sum --check --status', 'echo skip-sha'],
  ['pinned digest', '55672d1f392fd3e7b7a08621b6e804e6bcb39d40cf155504abb74b3a021ea8ea',
    '0000000000000000000000000000000000000000000000000000000000000000'],
  ['source provenance', 'test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"', 'echo skip-head'],
  ['real registration', 'node tests/zbrowse.portal-chrome-download-integrity.test.mjs',
    'echo skip-download-proof']
]) {
  assert.ok(workflow.includes(old), name + ': mutation target required');
  const tampered = workflow.replace(old, replacement);
  assert.throws(() => validate(tampered), { code: 'ERR_ASSERTION' },
    name + ': weakened download proof must fail closed');
}
console.log('Pinned Chrome download: HTTP/1.1, bounded retries, hash, 8 source mutations PASS');
