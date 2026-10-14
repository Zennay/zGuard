import assert from 'node:assert/strict';
import fs from 'node:fs';

const validate = fs.readFileSync(
  new URL('../zbrowse/scripts/validate.sh', import.meta.url),
  'utf8'
);

const requiredPortableChecks = [
  'zbrowse.contract.test.js',
  'zbrowse.request-ip.test.mjs',
  'zbrowse.request-path.test.mjs',
  'zbrowse.config-values.test.mjs',
  'zbrowse.base-provenance.test.mjs',
  'zbrowse.session-admission.test.mjs',
  'zbrowse.session-lifetime.test.mjs',
  'zbrowse.frontend-session.test.js',
  'zbrowse.iframe-capability-boundary.test.mjs',
  'zbrowse.gateway-containment.test.mjs',
  'zbrowse.gateway-dependency-audit.test.mjs',
  'zbrowse.install-preflight.test.mjs',
  'zbrowse.portal-accessibility.test.mjs',
  'zbrowse.repository-hygiene.test.js',
];

for (const test of requiredPortableChecks) {
  const command = `node ../tests/${test}`;
  const matches = validate.split(command).length - 1;
  assert.equal(matches, 1, `validate.sh must execute ${test} exactly once`);
}

// Offline release probes are valuable during local validation, but a
// production --live invocation must never be smuggled into validate.sh.
// Verify the entire shell command, rather than matching only the script name.
const offlineReleaseProbes = [
  'zbrowse.public-origin-readiness.test.mjs',
  'zbrowse.public-tv-static-release.test.mjs'
];
function assertOfflineProbeModes(script) {
  const lines = script.split(/\\r?\\n/);
  for (const probe of offlineReleaseProbes) {
    const command = `node ../tests/${probe} --self-test`;
    const invocations = lines.map(line => line.trim()).filter(line =>
      line.startsWith(`node ../tests/${probe}`));
    assert.deepEqual(invocations, [command],
      `${probe}: run exactly once and only in --self-test mode`);
  }
}
assertOfflineProbeModes(validate);
for (const probe of offlineReleaseProbes) {
  const safe = `node ../tests/${probe} --self-test`;
  assert.throws(() => assertOfflineProbeModes(validate.replace(safe,
    `node ../tests/${probe} --live`)),
  /only in --self-test mode/, `${probe}: live traffic mutation must fail`);
  assert.throws(() => assertOfflineProbeModes(validate.replace(safe, '')),
    /only in --self-test mode/, `${probe}: missing gate mutation must fail`);
  assert.throws(() => assertOfflineProbeModes(validate.replace(safe,
    safe + '\\n' + safe)),
  /only in --self-test mode/, `${probe}: duplicate gate mutation must fail`);
}

assert.match(
  validate,
  /node --check gateway\/server\.js/,
  'validate.sh must retain gateway server syntax validation'
);
assert.match(
  validate,
  /node --check gateway\/public\/app\.js/,
  'validate.sh must retain portal script syntax validation'
);
assert.match(
  validate,
  /bash -n scripts\/install\.sh/,
  'validate.sh must retain installer shell syntax validation'
);
assert.match(
  validate,
  /docker compose config >\/dev\/null/,
  'validate.sh must retain Compose validation when Docker is available'
);
assert.match(
  validate,
  /node \.\.\/tests\/zbrowse\.validation-entrypoint\.test\.mjs/,
  'validate.sh must self-check its portable regression inventory'
);

console.log('zBrowse validation entrypoint contract passed');
