import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync(
  new URL('../.github/workflows/gateway-dependency-audit.yml', import.meta.url),
  'utf8'
);
const packageJson = JSON.parse(
  fs.readFileSync(new URL('../zbrowse/gateway/package.json', import.meta.url), 'utf8')
);
const packageLock = JSON.parse(
  fs.readFileSync(new URL('../zbrowse/gateway/package-lock.json', import.meta.url), 'utf8')
);
const dockerfile = fs.readFileSync(
  new URL('../zbrowse/gateway/Dockerfile', import.meta.url),
  'utf8'
);

assert.equal(packageLock.lockfileVersion, 3, 'gateway lockfile must stay on npm lockfile v3');
assert.deepEqual(
  packageLock.packages?.['']?.dependencies,
  packageJson.dependencies,
  'gateway lockfile root dependency graph must exactly match package.json'
);
assert.match(
  dockerfile,
  /RUN npm ci --omit=dev/,
  'gateway image must install the locked production dependency graph'
);

assert.match(workflow, /runs-on:\s*ubuntu-latest/, 'dependency audit must use a portable hosted runner');
assert.match(workflow, /timeout-minutes:\s*10/, 'dependency audit must have a bounded timeout');
assert.match(
  workflow,
  /permissions:\s*\n\s+contents:\s*read/,
  'dependency audit token must remain read-only'
);
assert.match(
  workflow,
  /uses:\s*actions\/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10/,
  'dependency audit checkout must be pinned to the reviewed v6.0.3 commit'
);
assert.match(workflow, /persist-credentials:\s*false/, 'checkout credentials must not persist');
assert.match(
  workflow,
  /node tests\/zbrowse\.gateway-dependency-audit\.test\.mjs/,
  'workflow must self-validate its security contract'
);
assert.match(
  workflow,
  /npm ci --omit=dev --ignore-scripts/,
  'dependency audit must materialize the locked production graph without lifecycle scripts'
);
assert.match(
  workflow,
  /npm ls --omit=dev --all/,
  'dependency audit must verify the installed production graph is internally consistent'
);
assert.match(
  workflow,
  /npm audit --omit=dev --audit-level=high/,
  'dependency audit must fail on high or critical production vulnerabilities'
);

for (const path of [
  'zbrowse/gateway/package.json',
  'zbrowse/gateway/package-lock.json',
  'zbrowse/gateway/Dockerfile',
  'tests/zbrowse.gateway-dependency-audit.test.mjs',
  '.github/workflows/gateway-dependency-audit.yml',
]) {
  assert.ok(
    workflow.includes(`- "${path}"`),
    `dependency audit must trigger when ${path} changes`
  );
}

console.log('zBrowse gateway dependency audit contract passed');
