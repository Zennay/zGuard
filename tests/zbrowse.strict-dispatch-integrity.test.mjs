// Independent QA contract: opt-in failure gates must really execute the
// source-bound strict tests, not merely turn a green baseline into "proof".
// This is a read-only repository check: no Docker, public traffic, or VPS.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowDir = path.join(root, '.github/workflows');

// Map each manually-selectable remediation gate to its actual strict CLI(s).
// Entries intentionally include shared dispatch switches that run multiple
// different acceptances; all must remain wired, not just the first one.
const matrix = [
  ['zguard-live-settings-acceptance.yml', [
    ['require_live_settings', 'REQUIRE_LIVE_SETTINGS',
      [['zguard.content-live-settings.test.mjs', '--require-live-settings']]]
  ]],
  ['zbrowse-chromium-sandbox-posture.yml', [
    ['require_browser_sandbox', 'REQUIRE_BROWSER_SANDBOX',
      [['zbrowse.chromium-sandbox-posture.test.mjs', '--require-browser-sandbox']]]
  ]],
  ['zbrowse-trusted-host-origin-qa.yml', [
    ['require_canonical_host', 'REQUIRE_CANONICAL_HOST',
      [['zbrowse.host-origin-isolation-real-http.test.mjs', '--require-canonical-host']]]
  ]],
  ['zbrowse-disconnected-session-start.yml', [
    ['require_disconnect_reconciliation', 'REQUIRE_DISCONNECT_RECONCILIATION',
      [['zbrowse.disconnected-session-start-real-http.test.mjs',
        '--require-disconnect-reconciliation']]]
  ]],
  ['zbrowse-websocket-proxy-error-log-privacy.yml', [
    ['require_redacted_ws_proxy_errors', 'REQUIRE_REDACTED_WS_PROXY_ERRORS',
      [['zbrowse.websocket-proxy-error-log-privacy-real-tcp.test.mjs',
        '--require-redacted-ws-proxy-errors']]]
  ]],
  ['zbrowse-viewer-proxy-log-privacy.yml', [
    ['require_redacted_proxy_errors', 'REQUIRE_REDACTED_PROXY_ERRORS',
      [['zbrowse.proxy-error-log-privacy-real-http.test.mjs', '--require-redacted-proxy-errors']]]
  ]],
  ['zbrowse-viewer-range-cache.yml', [
    ['require_no_store', 'REQUIRE_NO_STORE',
      [['zbrowse.viewer-conditional-range-real-http.test.mjs', '--require-no-store']]]
  ]],
  ['zbrowse-conditional-health-cache.yml', [
    ['require_health_no_store', 'REQUIRE_HEALTH_NO_STORE',
      [['zbrowse.health-conditional-real-http.test.mjs', '--require-health-no-store']]]
  ]],
  ['zbrowse-json-origin-isolation.yml', [
    ['require_origin_isolation', 'REQUIRE_ORIGIN_ISOLATION',
      [['zbrowse.cross-origin-json-real-http.test.mjs', '--require-origin-isolation']]]
  ]],
  ['zbrowse-session-cache-privacy.yml', [
    ['require_no_store', 'REQUIRE_NO_STORE', [
      ['zbrowse.session-cache-privacy.test.mjs', '--require-no-store'],
      ['zbrowse.session-cache-real-http.test.mjs', '--require-no-store'],
      ['zbrowse.session-lifecycle-real-http.test.mjs', '--require-no-store']
    ]]
  ]],
  ['zbrowse-health-cache-readiness.yml', [
    ['require_health_no_store', 'REQUIRE_HEALTH_NO_STORE',
      [['zbrowse.health-cache-real-http.test.mjs', '--require-health-no-store']]]
  ]],
  ['zbrowse-teardown-failclosed.yml', [
    ['require_fail_closed', 'REQUIRE_FAIL_CLOSED', [
      ['zbrowse.teardown-failclosed.test.mjs', '--require-fail-closed'],
      ['zbrowse.teardown-admission-real-http.test.mjs', '--require-fail-closed'],
      ['zbrowse.shutdown-failed-cleanup.test.mjs', '--require-shutdown-fail-closed'],
      ['zbrowse.shutdown-admission-race-real-http.test.mjs', '--require-shutdown-drain'],
      ['zbrowse.inflight-shutdown-real-http.test.mjs', '--require-inflight-drain'],
      ['zbrowse.failed-start-cleanup.test.mjs', '--require-failed-start-fail-closed']
    ]]
  ]],
  ['zbrowse-rate-limit-identity.yml', [
    ['require_key_parity', 'REQUIRE_KEY_PARITY', [
      ['zbrowse.rate-limit-identity-parity.test.mjs', '--require-key-parity'],
      ['zbrowse.actual-session-limiter.test.mjs', '--require-source-parity']
    ]]
  ]],
  ['zbrowse-start-url-allowlist-validation.yml', [
    ['require_credential_free', 'REQUIRE_CREDENTIAL_FREE', [
      ['zbrowse.start-url-allowlist.test.mjs', '--require-credential-free'],
      ['zbrowse.start-url-real-http.test.mjs', '--require-credential-free']
    ]],
    ['require_json_only', 'REQUIRE_JSON_ONLY',
      [['zbrowse.cross-origin-simple-post-real-http.test.mjs', '--require-json-only']]]
  ]],
  ['zbrowse-viewer-cache-privacy.yml', [
    ['require_no_store', 'REQUIRE_NO_STORE', [
      ['zbrowse.viewer-cache-privacy.test.mjs', '--require-no-store'],
      ['zbrowse.viewer-cache-real-http.test.mjs', '--require-no-store'],
      ['zbrowse.viewer-path-recovery-real-http.test.mjs', '--require-no-store']
    ]],
    ['require_websocket_origin', 'REQUIRE_WEBSOCKET_ORIGIN',
      [['zbrowse.websocket-upgrade-auth-real-tcp.test.mjs', '--require-websocket-origin']]],
    ['require_websocket_host', 'REQUIRE_WEBSOCKET_HOST',
      [['zbrowse.websocket-upgrade-auth-real-tcp.test.mjs', '--require-websocket-host']]]
  ]],
  ['zbrowse-public-origin-readiness.yml', [
    ['require_valid_readiness', 'REQUIRE_VALID_READINESS',
      [['zbrowse.wait-for-browser-readiness.test.mjs', '--require-valid-readiness']]]
  ]],
  ['zbrowse-session-start-log-privacy.yml', [
    ['require_redacted_start_errors', 'REQUIRE_REDACTED_START_ERRORS',
      [['zbrowse.session-start-log-privacy-real-http.test.mjs', '--require-redacted-start-errors']]]
  ]],
  ['zbrowse-cleanup-error-log-privacy.yml', [
    ['require_redacted_cleanup_errors', 'REQUIRE_REDACTED_CLEANUP_ERRORS',
      [['zbrowse.cleanup-error-log-privacy.test.mjs', '--require-redacted-cleanup-errors']]]
  ]],
  ['zguard-real-firefox-acceptance.yml', [
    ['require_pageworld', 'REQUIRE_PAGEWORLD',
      [['zguard.firefox-real-browser.test.mjs', '--require-pageworld']]]
  ]],
  ['zguard-real-chromium-acceptance.yml', [
    ['require_mainworld', 'REQUIRE_MAINWORLD',
      [['zguard.chromium-real-browser.test.mjs', '--require-mainworld']]],
    ['require_coldstart', 'REQUIRE_COLDSTART',
      [['zguard.chromium-real-browser.test.mjs', '--cold-start']]],
    ['require_auxclick', 'REQUIRE_AUXCLICK',
      [['zguard.chromium-real-browser.test.mjs', '--require-auxclick']]],
    ['require_shadow_dom', 'REQUIRE_SHADOW_DOM',
      [['zguard.chromium-real-browser.test.mjs', '--require-shadow-dom']]],
    ['require_form_submit', 'REQUIRE_FORM_SUBMIT',
      [['zguard.chromium-real-browser.test.mjs', '--require-form-submit']]],
    ['require_image_map', 'REQUIRE_IMAGE_MAP',
      [['zguard.chromium-real-browser.test.mjs', '--require-image-map']]],
    ['require_svg_link', 'REQUIRE_SVG_LINK',
      [['zguard.chromium-real-browser.test.mjs', '--require-svg-link']]]
  ]]
];

// Audit the entire workflow directory rather than only explicitly known
// entries. A newly-added strict dispatch switch must never escape review just
// because its workflow was omitted from the hand-maintained matrix.
function unmappedStrictWorkflows(files, mapped = matrix) {
  const actual = files
    .filter(([name, yaml]) => /\.ya?ml$/i.test(name) &&
      /^      require_[a-z_]+:\s*$/m.test(yaml))
    .map(([name]) => name).sort();
  const expected = mapped.map(([name]) => name).sort();
  return { actual, expected };
}

const allWorkflowFiles = fs.readdirSync(workflowDir)
  .filter(name => /\.ya?ml$/i.test(name))
  .map(name => [name, fs.readFileSync(path.join(workflowDir, name), 'utf8')]);
const discovered = unmappedStrictWorkflows(allWorkflowFiles);
assert.deepEqual(discovered.actual, discovered.expected,
  'every workflow exposing require_* dispatch inputs must be registered in strict-remediation audit');
// Deliberately introduce an unmapped gate in memory to prove discovery fails
// closed for future workflow additions. No disk file or workflow is changed.
const fakeWorkflow = ['qa-unknown-strict-gate.yml',
  'on:\n  workflow_dispatch:\n    inputs:\n      require_unreviewed:\n        type: boolean\n'];
const missingMapping = unmappedStrictWorkflows([...allWorkflowFiles, fakeWorkflow]);
assert.notDeepEqual(missingMapping.actual, missingMapping.expected,
  'unmapped strict remediation workflow must be detected by directory discovery');

function testWorkflow(name, gates, yaml) {
  assert.match(yaml, /^  pull_request:\s*$/m, name + ': must run on PRs');
  assert.match(yaml, /^  push:\s*$/m, name + ': must run on main pushes');
  assert.match(yaml, /^  workflow_dispatch:\s*$/m, name + ': opt-ins must be dispatchable');
  assert.match(yaml, /^permissions:\s*\n  contents: read\s*$/m,
    name + ': workflow token must be read-only');
  assert.match(yaml, /runs-on: ubuntu-(?:latest|24\.04)/,
    name + ': remediation evidence must run on ephemeral hosted runner');
  assert.doesNotMatch(yaml, /runs-on:.*self-hosted/,
    name + ': never execute untrusted PR code on persistent runner');
  // A workflow may contain every expected strict command yet still be
  // skipped or reported green by Actions if someone adds a job/step if:false
  // or turns failures into tolerated outcomes. These gates are release
  // evidence; a skipped or non-blocking job is not valid acceptance.
  assert.doesNotMatch(yaml, /^\s*continue-on-error:\s*(?:true|\$\{\{)/mi,
    name + ': strict evidence cannot ignore job or step failures');
  assert.doesNotMatch(yaml, /^\s*if:\s*(?:false|\$\{\{\s*false\s*\}\})\s*$/mi,
    name + ': strict evidence cannot be a disabled job or step');
  assert.ok(yaml.includes('persist-credentials: false'),
    name + ': checkout must not persist token');
  assert.ok(yaml.includes('ref: ' + '$' +
    '{{ github.event.pull_request.head.sha || github.sha }}'),
  name + ': checkout must target exact proposed source');
  assert.ok(yaml.includes('test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"'),
    name + ': a green PR run is not by itself exact checkout evidence');
  assert.ok(yaml.includes('set -euo pipefail'),
    name + ': missing fail-fast shell mode');

  const observedInputs = [...yaml.matchAll(/^      (require_[a-z_]+):\s*$/gm)]
    .map(match => match[1]).sort();
  const mappedInputs = gates.map(gate => gate[0]).sort();
  assert.deepEqual(observedInputs, mappedInputs,
    name + ': new strict dispatch inputs need explicit audited CLI mapping');

  let executions = 0;
  for (const [input, env, commands] of gates) {
    const inputDeclaration = '      ' + input + ':';
    const inputStart = yaml.indexOf(inputDeclaration);
    assert.ok(inputStart >= 0, name + ': missing ' + input);
    const nextInput = yaml.indexOf('\n      require_', inputStart + inputDeclaration.length);
    const sectionEnd = nextInput < 0 ? yaml.indexOf('\npermissions:', inputStart) : nextInput;
    assert.ok(sectionEnd > inputStart, name + ': malformed input section ' + input);
    const declaration = yaml.slice(inputStart, sectionEnd);
    assert.match(declaration, /^        type: boolean\s*$/m,
      name + ': gate must be a boolean');
    assert.match(declaration, /^        default: false\s*$/m,
      name + ': unresolved runtime defect cannot be an implicit PASS');

    const envMapping = env + ': ' + '$' + "{{ inputs." + input + " || 'false' }}";
    assert.ok(yaml.includes(envMapping),
      name + ': dispatch input must reach its exact shell variable');

    const marker = 'if [ "$' + env + '" = "true" ]; then';
    const blockStart = yaml.indexOf(marker);
    assert.ok(blockStart >= 0, name + ': opt-in is not used in an explicit true-only guard');
    const blockEnd = yaml.indexOf('\n          fi', blockStart);
    assert.ok(blockEnd > blockStart, name + ': unterminated opt-in guard');
    const block = yaml.slice(blockStart + marker.length, blockEnd);
    assert.doesNotMatch(block, /\|\| true|continue-on-error|set \+e/,
      name + ': strict results must never be discarded');

    for (const [test, flag] of commands) {
      const normal = 'node tests/' + test;
      const strict = normal + ' ' + flag;
      assert.ok(yaml.slice(0, blockStart).split('\n').some(line => line.trim() === normal),
        name + ': baseline acceptance must run before strict ' + flag);
      assert.ok(block.split('\n').some(line => line.trim() === strict),
        name + ': strict CLI missing in gate ' + input);
      const sourcePath = path.join(root, 'tests', test);
      assert.ok(fs.statSync(sourcePath).isFile(), test + ': actual test must exist');
      const testSource = fs.readFileSync(sourcePath, 'utf8');
      // Chromium intentionally delegates its CLI options to a separate,
      // validated parser; assert both its invocation and the exact flag map.
      const delegatedBrowserFlag = test === 'zguard.chromium-real-browser.test.mjs' &&
        testSource.includes('parseAcceptanceFlags(process.argv.slice(2))') &&
        fs.readFileSync(path.join(root, 'tools/real-browser-flags.mjs'), 'utf8')
          .includes("['" + flag + "',");
      assert.ok(testSource.includes(flag) || delegatedBrowserFlag,
        test + ': strict flag is not handled by the named test or reviewed CLI parser');
      executions++;
    }
  }
  return executions;
}

// Mutation self-tests prove the sentinel catches misleading green gates
// rather than only matching currently-valid source text.
const [sample, sampleGates] = matrix.find(([name]) =>
  name === 'zbrowse-json-origin-isolation.yml');
const fixture = fs.readFileSync(path.join(workflowDir, sample), 'utf8');

// Issue #342 has been remediated in the shipped gateway: prevent regression
// by requiring the browser-simple non-JSON admission test UNCONDITIONALLY on
// every PR and main push, not hidden behind workflow_dispatch inputs.
// Only exact executable shell lines before the opt-in block qualify as proof.
const mandatorySimplePost = 'node tests/zbrowse.cross-origin-simple-post-real-http.test.mjs --require-json-only';
function assertMandatorySimplePost(yaml) {
  const optIn = yaml.indexOf('if [ "$REQUIRE_ORIGIN_ISOLATION" = "true" ]; then');
  assert.ok(optIn > 0, 'origin workflow must retain its separate manual opt-in');
  const runStep = yaml.indexOf('      - name: Exercise shipped JSON origin boundary');
  assert.ok(runStep >= 0 && runStep < optIn,
    'mandatory admission proof must live in the actual executed origin job');
  const unconditional = yaml.slice(runStep, optIn).split(/\r?\n/);
  assert.ok(unconditional.some(line => line.trim() === mandatorySimplePost),
    'real HTTP browser-simple POST JSON-only acceptance must always run before optional dispatch');
  assert.equal((yaml.match(/node tests\/zbrowse\.cross-origin-simple-post-real-http\.test\.mjs --require-json-only/g) || []).length, 1,
    'do not duplicate the gate in an optional path or comment for false green evidence');
}
assertMandatorySimplePost(fixture);
for (const mutated of [
  fixture.replace(mandatorySimplePost,
    'node tests/zbrowse.cross-origin-simple-post-real-http.test.mjs'),
  fixture.replace(mandatorySimplePost,
    'echo node tests/zbrowse.cross-origin-simple-post-real-http.test.mjs --require-json-only'),
  fixture.replace(mandatorySimplePost,
    '# node tests/zbrowse.cross-origin-simple-post-real-http.test.mjs --require-json-only'),
  fixture.replace(
    mandatorySimplePost + '\n          if [ "$REQUIRE_ORIGIN_ISOLATION" = "true" ]; then',
    'if [ "$REQUIRE_ORIGIN_ISOLATION" = "true" ]; then\n          ' + mandatorySimplePost)
]) {
  assert.notEqual(mutated, fixture,
    'mutation fixture must alter the always-on JSON-only gate');
  assert.throws(() => assertMandatorySimplePost(mutated),
    /must always run|do not duplicate|real HTTP browser-simple/,
    'removing or masking mandatory simple POST proof must fail the source contract');
}
const tamper = (original, replacement, reason) => {
  assert.notEqual(original, replacement, reason + ': mutation must change fixture');
  assert.throws(() => testWorkflow(sample, sampleGates, replacement),
    undefined, reason + ': regression must fail closed');
};
// Assertions above are not just policy documentation: deliberately inject
// skipped/non-blocking GitHub Actions jobs and verify all are rejected.
for (const [label, injected] of [
  ['job cannot ignore failure', '    continue-on-error: true'],
  ['step cannot ignore failure', '      continue-on-error: true'],
  ['job cannot be disabled', '    if: false'],
  ['expression cannot disable gate', '    if: ${{ false }}']
]) {
  const changed = fixture.replace('    runs-on: ubuntu-24.04',
    '    runs-on: ubuntu-24.04\n' + injected);
  assert.notEqual(changed, fixture, label + ': test mutation must change workflow');
  assert.throws(() => testWorkflow(sample, sampleGates, changed),
    undefined, label + ': strict CI cannot report false-green skipped work');
}

tamper(fixture, fixture.replace('default: false', 'default: true'),
  'disabled-by-default security gate');
tamper(fixture, fixture.replace('REQUIRE_ORIGIN_ISOLATION: ' +
  '$' + "{{ inputs.require_origin_isolation || 'false' }}", 'REQUIRE_ORIGIN_ISOLATION: false'),
  'dispatch-to-environment disconnect');
// This strict check is also mandatory on PRs. Mutate the *opt-in* copy,
// otherwise the unconditional gate is accidentally changed instead and the
// dispatch-integrity self-test would report a false green.
const optInStrict = 'node tests/zbrowse.cross-origin-json-real-http.test.mjs --require-origin-isolation';
const optInOffset = fixture.lastIndexOf(optInStrict);
assert.ok(optInOffset >= 0, 'the reviewed opt-in strict command must exist');
tamper(fixture, fixture.slice(0, optInOffset) +
  'node tests/zbrowse.cross-origin-json-real-http.test.mjs' +
  fixture.slice(optInOffset + optInStrict.length),
'false green from baseline-only execution');
tamper(fixture, fixture.replace(
  'node tests/zbrowse.cross-origin-json-real-http.test.mjs\n',
  'echo omitted-baseline\n'), 'missing independent baseline control');
tamper(fixture, fixture.replace('  workflow_dispatch:\n',
  '  workflow_dispatch:\n    inputs:\n      require_new_gate:\n        type: boolean\n        default: false\n'),
'unknown dispatch input cannot be silently ignored');

let strictCommands = 0;
for (const [workflow, gates] of matrix) {
  strictCommands += testWorkflow(workflow, gates,
    fs.readFileSync(path.join(workflowDir, workflow), 'utf8'));
}
console.log('Strict remediation workflow/CLI integrity passed: ' +
  matrix.length + ' hosted workflows, ' +
  matrix.reduce((count, [, gates]) => count + gates.length, 0) +
  ' explicitly opt-in gates, ' + strictCommands +
  ' strict source-bound test commands, 5 CLI wiring mutations and 1 unmapped-workflow discovery proof');
