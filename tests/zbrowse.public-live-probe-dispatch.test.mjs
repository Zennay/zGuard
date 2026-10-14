// Keep production-network GET probes opt-in: PR/push CI must be fixture-only.
// This is a repository-level contract with mutation self-tests; it never makes
// external requests and never starts sessions or browser containers.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflowPath = new URL('../.github/workflows/zbrowse-public-origin-readiness.yml',
  import.meta.url);
const workflow = fs.readFileSync(workflowPath, 'utf8');
const liveCommands = [
  'node tests/zbrowse.public-origin-readiness.test.mjs --live',
  'node tests/zbrowse.public-tv-static-release.test.mjs --live'
];
const selfTestCommands = liveCommands.map(command =>
  command.replace(' --live', ' --self-test'));

function verifyDispatchGuard(source) {
  assert.match(source, /^  pull_request:\s*$/m,
    'PRs must exercise only synthetic readiness fixtures');
  assert.match(source, /^  push:\s*\n    branches:\s*\n      - main\s*$/m,
    'merged source must re-run synthetic acceptance');
  assert.match(source, /^  workflow_dispatch:\s*$/m,
    'explicit operator dispatch must remain available');
  assert.ok(source.includes('LIVE_PROBE_EVENT: ' +
    '$' + '{{ github.event_name }}'),
    'public release mode must depend on trusted Actions event_name');
  assert.ok(source.includes('set -euo pipefail'),
    'public release probe must fail on any command error');
  assert.ok(source.includes('persist-credentials: false'),
    'public checks must not leave the GitHub token in the checkout');
  assert.ok(source.includes('ref: ' + '$' +
    '{{ github.event.pull_request.head.sha || github.sha }}'),
    'run must prove selected release commit');
  assert.ok(source.includes('test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"'),
    'requested source HEAD must be verified before any tests run');

  const marker = '          if [ "$LIVE_PROBE_EVENT" = "workflow_dispatch" ]; then';
  const guardStart = source.indexOf(marker);
  assert.ok(guardStart >= 0, 'public live probes require trusted dispatch-only guard');
  assert.equal(source.indexOf(marker, guardStart + marker.length), -1,
    'only one reviewed public live probe guard is allowed');
  const close = source.indexOf('\n          fi', guardStart + marker.length);
  assert.ok(close > guardStart, 'dispatch-only probe guard must terminate');
  const guardedLines = source.slice(guardStart + marker.length, close)
    .split('\n').map(line => line.trim()).filter(Boolean);
  assert.deepEqual(guardedLines, liveCommands,
    'only the two reviewed GET-only live probes may execute inside dispatch');
  const allLiveCommandLines = source.split('\n')
    .map(line => line.trim())
    .filter(line => /^node\s+tests\/.*\s--live(?:\s|$)/.test(line));
  assert.deepEqual(allLiveCommandLines, liveCommands,
    'no extra or unguarded public --live invocation is allowed');

  const guardIndex = source.indexOf(marker);
  for (const command of selfTestCommands) {
    const selfIndex = source.indexOf('          ' + command);
    assert.ok(selfIndex > 0 && selfIndex < guardIndex,
      command + ': offline fixture tests must precede the live-only block');
    assert.equal(source.indexOf('          ' + command, selfIndex + 1), -1,
      command + ': fixture acceptance must run exactly once');
  }
  // Both binaries enforce explicit modes rather than treating missing flags
  // as implicit live access; a CI typo cannot silently probe production.
  for (const command of liveCommands) {
    const relative = command.slice('node '.length).split(' ')[0];
    const cli = fs.readFileSync(new URL('../' + relative, import.meta.url), 'utf8');
    assert.ok(cli.includes("'--self-test'") && cli.includes("'--live'") &&
      cli.includes('readOnlyMode(process.argv.slice(2))'),
    relative + ': CLI must reject implicit or malformed public-probe modes');
  }
  // A green fixture check must not be used as evidence of a manually
  // requested public release check if the --live entrypoint is later rewired
  // to a stub, a fixture, or a skipped branch. The same exported functions
  // exercised by --self-test must execute in the live branch. These are
  // source-binding assertions only; NO public network probe is performed.
  for (const [filename, binding, callable] of [
    ['zbrowse.public-origin-readiness.test.mjs', 'health', 'checkPublicReadiness'],
    ['zbrowse.public-tv-static-release.test.mjs', 'assets', 'verifyPublicStaticRelease']
  ]) {
    const source = fs.readFileSync(new URL('./' + filename, import.meta.url), 'utf8');
    verifyLiveEntrypoint(source, binding, callable, filename);
  }
  return liveCommands.length;
}

// Keep the actual CLI tail anchored to the reviewed mode switch. In
// particular, merely mentioning the real probe in an unused comment or
// helper must not certify a successful --live invocation.
function verifyLiveEntrypoint(source, binding, callable, name) {
  const marker = 'const mode = readOnlyMode(process.argv.slice(2));';
  const start = source.lastIndexOf(marker);
  assert.ok(start >= 0, name + ': explicit CLI mode selector is required');
  const tail = source.slice(start);
  const expected = marker + "\n" +
    "if (mode === '--self-test') {\n" +
    "  await selfTest();\n" +
    "} else {\n" +
    "  const " + binding + " = await " + callable + "();\n";
  assert.ok(tail.startsWith(expected),
    name + ': --live must directly execute the reviewed function, not a fixture or stub');
  assert.match(tail, /\n}\s*$/,
    name + ': entrypoint must end with its reviewed live branch');
}



assert.equal(verifyDispatchGuard(workflow), 2);
const tamper = (name, mutated) => {
  assert.notEqual(mutated, workflow, name + ': mutation must alter workflow');
  assert.throws(() => verifyDispatchGuard(mutated),
    undefined, name + ': unsafe production-probe wiring must fail');
};
tamper('unguarded probe', workflow + '\n          node tests/zbrowse.public-origin-readiness.test.mjs --live\n');
tamper('untrusted event source', workflow.replace(
  'LIVE_PROBE_EVENT: ' + '$' + '{{ github.event_name }}',
  'LIVE_PROBE_EVENT: ' + '$' + '{{ inputs.run_live }}'));
tamper('unconditional execution', workflow.replace(
  'if [ "$LIVE_PROBE_EVENT" = "workflow_dispatch" ]; then',
  'if true; then'));
tamper('skipped TV identity release proof', workflow.replace(
  'node tests/zbrowse.public-tv-static-release.test.mjs --live',
  'node tests/zbrowse.public-tv-static-release.test.mjs --self-test'));
tamper('missing offline TV fixture', workflow.replace(
  '          node tests/zbrowse.public-tv-static-release.test.mjs --self-test\n', ''));
tamper('duplicated live identity probe', workflow.replace(
  '            node tests/zbrowse.public-tv-static-release.test.mjs --live',
  '            node tests/zbrowse.public-tv-static-release.test.mjs --live\n' +
  '            node tests/zbrowse.public-tv-static-release.test.mjs --live'));

// Exercise source entrypoint wiring with deliberate in-memory tampering.
for (const [filename, binding, callable] of [
  ['zbrowse.public-origin-readiness.test.mjs', 'health', 'checkPublicReadiness'],
  ['zbrowse.public-tv-static-release.test.mjs', 'assets', 'verifyPublicStaticRelease']
]) {
  const source = fs.readFileSync(new URL('./' + filename, import.meta.url), 'utf8');
  verifyLiveEntrypoint(source, binding, callable, filename);
  const real = 'const ' + binding + ' = await ' + callable + '();';
  const changed = source.replace(real, 'const ' + binding + ' = await selfTest();');
  assert.notEqual(changed, source, filename + ': mutation must replace live call');
  assert.throws(() => verifyLiveEntrypoint(changed, binding, callable, filename),
    undefined, filename + ': a fixture must not masquerade as a live release probe');
  const skipped = source.replace("if (mode === '--self-test') {", 'if (true) {');
  assert.notEqual(skipped, source, filename + ': mutation must replace mode selector');
  assert.throws(() => verifyLiveEntrypoint(skipped, binding, callable, filename),
    undefined, filename + ': unconditionally skipping live execution must fail');
}

console.log('Public TV release dispatch guard passed: 2 manual GET-only probes, 6 dispatch + 4 live-binding mutation checks');
