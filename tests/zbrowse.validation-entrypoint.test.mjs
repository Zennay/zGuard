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
