import assert from 'node:assert/strict';
import fs from 'node:fs';

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
const workflow = fs.readFileSync(
  new URL('../.github/workflows/gateway-node-runtime-compatibility.yml', import.meta.url),
  'utf8'
);

function minimumNodeMajor(engine) {
  assert.equal(typeof engine, 'string', 'Node engine requirement must be a string');
  const match = engine.trim().match(/^>=\s*(\d+)(?:\.\d+(?:\.\d+)?)?$/);
  assert.ok(
    match,
    'Node engine policy must remain a simple reviewed lower bound such as >=20'
  );
  return Number(match[1]);
}

function dockerNodeMajor(source) {
  const from = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith('FROM '));
  assert.ok(from, 'gateway Dockerfile must declare a FROM image');

  const image = from.slice('FROM '.length).trim().split(/\s+/)[0];
  const match = image.match(/^node:(\d+)(?:\.\d+\.\d+)?-alpine@sha256:[0-9a-f]{64}$/);
  assert.ok(
    match,
    'gateway Dockerfile must use a digest-pinned official node:<major>-alpine image'
  );
  return Number(match[1]);
}

function assertRuntimeCompatible(engine, dockerSource) {
  const requiredMajor = minimumNodeMajor(engine);
  const imageMajor = dockerNodeMajor(dockerSource);
  assert.ok(
    imageMajor >= requiredMajor,
    `gateway image Node ${imageMajor} does not satisfy package engine >=${requiredMajor}`
  );
}

const nodeEngine = packageJson.engines?.node;
assertRuntimeCompatible(nodeEngine, dockerfile);
assert.deepEqual(
  packageLock.packages?.['']?.engines,
  packageJson.engines,
  'lockfile root engine policy must match package.json'
);

assert.doesNotThrow(
  () => assertRuntimeCompatible('>=20', 'FROM node:22-alpine@sha256:' + 'a'.repeat(64)),
  'compatibility self-test must accept a newer runtime major'
);
assert.throws(
  () => assertRuntimeCompatible('>=24', 'FROM node:22-alpine@sha256:' + 'a'.repeat(64)),
  /does not satisfy package engine/,
  'compatibility self-test must reject a runtime older than the package engine minimum'
);
assert.throws(
  () => minimumNodeMajor('^22.0.0'),
  /simple reviewed lower bound/,
  'compatibility self-test must require explicit review before changing engine-range grammar'
);

assert.match(
  workflow,
  /runs-on:\s*ubuntu-latest/,
  'Node runtime compatibility validation must use a portable hosted runner'
);
assert.match(
  workflow,
  /permissions:\s*\n\s+contents:\s*read/,
  'Node runtime compatibility workflow token must remain read-only'
);
assert.match(
  workflow,
  /uses:\s*actions\/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10/,
  'Node runtime compatibility checkout must be pinned to the reviewed v6.0.3 commit'
);
assert.match(workflow, /persist-credentials:\s*false/, 'checkout credentials must not persist');
assert.match(
  workflow,
  /node tests\/zbrowse\.gateway-node-runtime-compatibility\.test\.mjs/,
  'workflow must execute the Node runtime compatibility contract'
);

for (const path of [
  'zbrowse/gateway/package.json',
  'zbrowse/gateway/package-lock.json',
  'zbrowse/gateway/Dockerfile',
  'tests/zbrowse.gateway-node-runtime-compatibility.test.mjs',
  '.github/workflows/gateway-node-runtime-compatibility.yml',
]) {
  assert.ok(
    workflow.includes(`- "${path}"`),
    `Node runtime compatibility workflow must trigger when ${path} changes`
  );
}

console.log('zBrowse gateway Node runtime compatibility contract passed');
