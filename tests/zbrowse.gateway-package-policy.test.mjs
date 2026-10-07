import assert from 'node:assert/strict';
import fs from 'node:fs';

const packageJsonUrl = new URL('../zbrowse/gateway/package.json', import.meta.url);
const packageLockUrl = new URL('../zbrowse/gateway/package-lock.json', import.meta.url);
const workflowUrl = new URL('../.github/workflows/gateway-package-policy-validation.yml', import.meta.url);

const packageJson = JSON.parse(fs.readFileSync(packageJsonUrl, 'utf8'));
const packageLock = JSON.parse(fs.readFileSync(packageLockUrl, 'utf8'));
const workflow = fs.readFileSync(workflowUrl, 'utf8');

const forbiddenLifecycleScripts = new Set([
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepublish',
  'prepublishOnly',
]);

const registrySemver = /^(?:[~^])?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function validateManifest(manifest) {
  const errors = [];

  if (manifest.private !== true) errors.push('gateway package must remain private');
  if (manifest.type !== 'module') errors.push('gateway package must remain ESM');
  if (manifest.scripts?.start !== 'node server.js') {
    errors.push('gateway start script must remain the reviewed local Node entrypoint');
  }
  if (manifest.scripts?.check !== 'node --check server.js && node --check public/app.js') {
    errors.push('gateway check script must remain syntax-only and local');
  }

  for (const name of Object.keys(manifest.scripts || {})) {
    if (forbiddenLifecycleScripts.has(name)) {
      errors.push(`forbidden lifecycle script: ${name}`);
    }
  }

  for (const [name, specifier] of Object.entries(manifest.dependencies || {})) {
    if (typeof specifier !== 'string' || !registrySemver.test(specifier)) {
      errors.push(`dependency ${name} must use a registry semver range`);
    }
  }

  return errors;
}

assert.deepEqual(validateManifest(packageJson), [], 'gateway package policy must pass');

const lockRoot = packageLock.packages?.[''];
assert.ok(lockRoot, 'gateway lockfile must contain the root package');
assert.equal(lockRoot.name, packageJson.name, 'lockfile root name must match package.json');
assert.equal(lockRoot.version, packageJson.version, 'lockfile root version must match package.json');
assert.deepEqual(lockRoot.engines, packageJson.engines, 'lockfile root engine policy must match package.json');
assert.deepEqual(
  lockRoot.dependencies,
  packageJson.dependencies,
  'lockfile root dependencies must match package.json'
);

const lifecycleFixture = JSON.parse(JSON.stringify(packageJson));
lifecycleFixture.scripts.postinstall = 'node server.js';
assert.ok(
  validateManifest(lifecycleFixture).includes('forbidden lifecycle script: postinstall'),
  'policy self-test must reject install-time lifecycle execution'
);

const remoteDependencyFixture = JSON.parse(JSON.stringify(packageJson));
remoteDependencyFixture.dependencies.express = 'https://example.invalid/express.tgz';
assert.ok(
  validateManifest(remoteDependencyFixture).includes('dependency express must use a registry semver range'),
  'policy self-test must reject remote tarball dependencies'
);

const aliasDependencyFixture = JSON.parse(JSON.stringify(packageJson));
aliasDependencyFixture.dependencies.express = 'npm:other-package@1.2.3';
assert.ok(
  validateManifest(aliasDependencyFixture).includes('dependency express must use a registry semver range'),
  'policy self-test must reject npm aliases'
);

const commandFixture = JSON.parse(JSON.stringify(packageJson));
commandFixture.scripts.start = 'node other.js';
assert.ok(
  validateManifest(commandFixture).includes(
    'gateway start script must remain the reviewed local Node entrypoint'
  ),
  'policy self-test must reject start-entrypoint drift'
);

assert.match(workflow, /runs-on:\s*ubuntu-latest/, 'package policy validation must use a portable hosted runner');
assert.match(
  workflow,
  /permissions:\s*\n\s+contents:\s*read/,
  'package policy workflow token must remain read-only'
);
assert.match(
  workflow,
  /uses:\s*actions\/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10/,
  'package policy checkout must be pinned to the reviewed v6.0.3 commit'
);
assert.match(workflow, /persist-credentials:\s*false/, 'checkout credentials must not persist');
assert.match(
  workflow,
  /node tests\/zbrowse\.gateway-package-policy\.test\.mjs/,
  'workflow must execute the package policy contract'
);

for (const path of [
  'zbrowse/gateway/package.json',
  'zbrowse/gateway/package-lock.json',
  'tests/zbrowse.gateway-package-policy.test.mjs',
  '.github/workflows/gateway-package-policy-validation.yml',
]) {
  assert.ok(workflow.includes(`- "${path}"`), `package policy workflow must trigger when ${path} changes`);
}

console.log('zBrowse gateway package policy contract passed');
