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

// Substring matches can incorrectly count comments, disabled commands or
// a test whose failure is masked by '|| true' as executed validation.
// Require one canonical, unmasked shell line for each portable regression.
function assertPortableChecks(script) {
  const lines = script.split(/\r?\n/).map(line => line.trim());
  for (const test of requiredPortableChecks) {
    const command = `node ../tests/${test}`;
    const invocations = lines.filter(line => line.startsWith(command));
    assert.deepEqual(invocations, [command],
      `validate.sh must execute ${test} exactly once without masking failures`);
  }
}
assertPortableChecks(validate);
const mutationTarget = 'node ../tests/zbrowse.request-ip.test.mjs';
for (const replacement of [
  '# ' + mutationTarget,
  mutationTarget + ' || true',
  mutationTarget + ' >/dev/null 2>&1 || :',
  mutationTarget + ' # disabled',
  mutationTarget + '\n' + mutationTarget,
  ''
]) {
  assert.throws(() => assertPortableChecks(validate.replace(mutationTarget, replacement)),
    /without masking failures/,
    'a disabled, duplicated or failure-masked portable check must fail validation');
}

// Offline release probes are valuable during local validation, but a
// production --live invocation must never be smuggled into validate.sh.
// Verify the entire shell command, rather than matching only the script name.
// The reviewed gateway security checks are mandatory offline release gates.
// Especially for bearer-token routes, accidentally omitting a strict flag
// would silently run observational tests instead of acceptance assertions.
const strictSecurityCommands = [
  'node ../tests/zbrowse.sites-config-safety.test.mjs',
  'node ../tests/zbrowse.security-headers-contract.test.mjs',
  'node ../tests/zbrowse.start-url-allowlist.test.mjs --require-credential-free',
  'node ../tests/zbrowse.session-cache-privacy.test.mjs --require-no-store',
  'node ../tests/zbrowse.viewer-cache-privacy.test.mjs --require-no-store'
];
function assertStrictSecurityCommands(script) {
  const lines = script.split(/\r?\n/).map(line => line.trim());
  for (const command of strictSecurityCommands) {
    const filename = command.split(' ')[2];
    const invocations = lines.filter(line =>
      line.startsWith('node ' + filename));
    assert.deepEqual(invocations, [command],
      filename + ': require one strict, unmasked offline security command');
  }
}
assertStrictSecurityCommands(validate);
for (const original of strictSecurityCommands) {
  for (const altered of [
    '# ' + original,
    original + ' || true',
    original + '\n' + original,
    original.replace(/ --require-(?:credential-free|no-store)$/, ''),
    ''
  ]) {
    if (altered === original) continue;
    assert.throws(() => assertStrictSecurityCommands(validate.replace(original, altered)),
      /strict, unmasked offline security command/,
      'a weak, skipped or duplicate strict gateway preflight must be rejected');
  }
}

const offlineReleaseProbes = [
  'zbrowse.public-origin-readiness.test.mjs',
  'zbrowse.public-tv-static-release.test.mjs'
];
function assertOfflineProbeModes(script) {
  const lines = script.split(/\r?\n/);
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
    safe + '\n' + safe)),
  /only in --self-test mode/, `${probe}: duplicate gate mutation must fail`);
}

const shellValidationCommands = [
  'node --check gateway/server.js',
  'node --check gateway/public/app.js',
  'bash -n scripts/install.sh',
  'bash -n browser/root/usr/local/bin/start-zbrowse',
  'docker compose config >/dev/null',
  'node ../tests/zbrowse.validation-entrypoint.test.mjs'
];
function assertShellValidationCommands(script) {
  const lines = script.split(/\r?\n/).map(line => line.trim());
  for (const command of shellValidationCommands) {
    assert.deepEqual(lines.filter(line => line.startsWith(command)), [command],
      command + ': validate.sh must preserve exact unmasked command');
  }
}
assertShellValidationCommands(validate);
for (const replacement of [
  '# node --check gateway/server.js',
  'node --check gateway/server.js || true',
  'node --check gateway/server.js; true',
  'node --check gateway/server.js && :',
  'node --check gateway/server.js\nnode --check gateway/server.js',
  ''
]) {
  assert.throws(() => assertShellValidationCommands(
    validate.replace('node --check gateway/server.js', replacement)),
  /unmasked command/, 'selftest must detect disabled or masked syntax gate');
}

console.log('zBrowse validation entrypoint contract passed');
