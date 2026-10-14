// Read-only Selkies kiosk hardening gate for issue #10.
// This inspects the actual Docker createContainer Env array in server.js.
// It does NOT prove what the deployed base image or a running VPS enforces.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseStrictAcceptanceArgs } from '../tools/gateway-strict-acceptance-flags.mjs';

const strict = parseStrictAcceptanceArgs(process.argv.slice(2), '--require-selkies-hardening');
const source = fs.readFileSync(new URL('../zbrowse/gateway/server.js', import.meta.url), 'utf8');

// Reject ambiguous/duplicated environment settings instead of trusting the
// first or last setting Docker/Selkies might use.
function parseContainerEnv(input) {
  const match = input.match(/\bEnv:\s*\[([\s\S]*?)\]\s*,\s*Labels\s*:/);
  assert.ok(match, 'inspectable Docker createContainer Env array required');
  const env = new Map();
  for (const [index, raw] of match[1].split(/\r?\n/).entries()) {
    const line = raw.trim().replace(/,$/, '');
    if (!line) continue;
    const entry = line.match(/^([\x22'\x60])([A-Z][A-Z0-9_]*)=([^\x22'\x60]*)\1$/);
    assert.ok(entry, 'Env line ' + (index + 1) + ' must be a literal inspectable NAME=value');
    const [, quote, key, value] = entry;
    assert.ok(!env.has(key), 'duplicate Docker Env setting: ' + key);
    // The only accepted interpolation is already-reviewed session-specific
    // Docker environment. The hardening settings must always be literals.
    if (quote === '\x60') {
      assert.ok(
        !value.includes('${') || (
          ['PASSWORD', 'SUBFOLDER', 'START_URL'].includes(key) &&
          /^\$\{(?:password|subfolder|startUrl)\}$/.test(value)
        ),
        'unreviewed environment interpolation: ' + key
      );
    }
    env.set(key, value);
  }
  assert.ok(env.size >= 5, 'unexpectedly empty Docker browser environment');
  return env;
}

const required = new Map([
  ['HARDEN_DESKTOP', 'true'],
  ['HARDEN_OPENBOX', 'true'],
  ['SELKIES_FILE_TRANSFERS', 'none'],
  ['SELKIES_ENABLE_CLIPBOARD', 'false|locked'],
  ['SELKIES_COMMAND_ENABLED', 'false|locked'],
  ['NO_WEBCAM', 'true'],
  ['NO_GAMEPAD', 'true'],
  ['START_DOCKER', 'false']
]);
const legacy = ['SELKIES_ENABLE_FILE_TRANSFER'];

function postureGaps(env) {
  const gaps = [];
  for (const [key, expected] of required) {
    if (env.get(key) !== expected) gaps.push(key);
  }
  for (const key of legacy) if (env.has(key)) gaps.push(key);
  return gaps;
}

const compliant = parseContainerEnv(source);
compliant.delete('SELKIES_ENABLE_FILE_TRANSFER');
for (const [key, value] of required) compliant.set(key, value);
assert.deepEqual(postureGaps(compliant), [],
  'a reviewed hardened fixture must satisfy the strict kiosk contract');

// Prove every omitted/relaxed setting is caught, rather than producing a
// meaningless green status based on a hard-coded baseline.
for (const [key] of required) {
  const omitted = new Map(compliant);
  omitted.delete(key);
  assert.ok(postureGaps(omitted).includes(key), key + ': omission must fail');
  const weakened = new Map(compliant);
  weakened.set(key, 'true' === required.get(key) ? 'false' : 'true');
  assert.ok(postureGaps(weakened).includes(key), key + ': weakened setting must fail');
}
for (const key of legacy) {
  const reverted = new Map(compliant);
  reverted.set(key, 'false');
  assert.ok(postureGaps(reverted).includes(key),
    'deprecated Selkies env names must not silently pass');
}

// Test the shipped parser against duplicate keys, non-literal keys and
// interpolated hardening settings. These are negative source mutations.
const marker = '      "SELKIES_ENABLE_CLIPBOARD=false"';
assert.ok(source.includes(marker), 'baseline source mutation anchor must exist');
for (const mutation of [
  marker + ',\n      "SELKIES_ENABLE_CLIPBOARD=true"',
  '      "SELKIES_ENABLE_CLIPBOARD=false",\n      runtimeEnv',
  '      `HARDEN_DESKTOP=\x24{otherInput}`'
]) {
  const modified = source.replace(marker, mutation);
  assert.notEqual(modified, source, 'mutation must actually change source');
  assert.throws(() => parseContainerEnv(modified),
    { code: 'ERR_ASSERTION' }, 'unsafe/malformed runtime Env must fail');
}

// The release-mode workflow must not claim a strict pass by silently
// re-running the advisory test or dropping its dispatch boolean.
const workflow = fs.readFileSync(
  new URL('../.github/workflows/zbrowse-selkies-hardening-posture.yml', import.meta.url),
  'utf8'
);
function checkReleaseWiring(yaml) {
  assert.ok(yaml.includes("REQUIRE_HARDENING: ${{ inputs.require_selkies_hardening || 'false' }}"),
    'workflow_dispatch boolean must reach the acceptance job');
  assert.match(yaml, /^\s+node tests\/zbrowse\.selkies-hardening-posture\.test\.mjs\s*$/m,
    'normal PR/push must execute the source regression');
  assert.match(yaml,
    /if \[ "\$REQUIRE_HARDENING" = "true" \]; then\s*\n\s*node tests\/zbrowse\.selkies-hardening-posture\.test\.mjs --require-selkies-hardening/,
    'strict dispatch must execute the release gate, not repeat advisory mode');
  assert.ok(yaml.includes('ref: ${{ github.event.pull_request.head.sha || github.sha }}'),
    'workflow must checkout the requested PR head');
  assert.ok(yaml.includes('test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"'),
    'workflow must prove exact checked-out commit');
}
checkReleaseWiring(workflow);
for (const weakened of [
  workflow.replace('node tests/zbrowse.selkies-hardening-posture.test.mjs --require-selkies-hardening',
    'node tests/zbrowse.selkies-hardening-posture.test.mjs'),
  workflow.replace("inputs.require_selkies_hardening || 'false'",
    "'false'"),
  workflow.replace('ref: ${{ github.event.pull_request.head.sha || github.sha }}',
    'ref: main')
]) {
  assert.notEqual(weakened, workflow, 'release-wiring mutation must change the workflow');
  assert.throws(() => checkReleaseWiring(weakened),
    { code: 'ERR_ASSERTION' }, 'weakened strict dispatch/provenance must fail QA');
}

const observed = parseContainerEnv(source);
const gaps = postureGaps(observed);
// Baseline advisory mode permits ONLY the existing known gap: the old
// unlocked clipboard value and the legacy transfer variable. New unsafe
// explicitly-set hardening values are a regression even before strict mode.
for (const [key, expected] of required) {
  if (!observed.has(key) || observed.get(key) === expected) continue;
  assert.equal(key, 'SELKIES_ENABLE_CLIPBOARD',
    'newly configured hardening flags must use reviewed safe values: ' + key);
  assert.equal(observed.get(key), 'false',
    'legacy clipboard setting is the only allowed baseline exception');
}
if (observed.has('SELKIES_ENABLE_FILE_TRANSFER')) {
  assert.equal(observed.get('SELKIES_ENABLE_FILE_TRANSFER'), 'false',
    'do not turn the existing legacy transfer setting into an unsafe value');
}
if (strict) {
  assert.deepEqual(gaps, [], 'Selkies kiosk release gate (#10) requires exact hardening');
  console.log('Selkies source hardening gate PASS; real VPS effective posture still required');
} else {
  console.log('Selkies source hardening: ' + (gaps.length ? 'NOT RELEASE-READY' : 'source-ready') +
    '; ' + gaps.length + ' issue #10 setting gaps; ' +
    'strict gate: --require-selkies-hardening. No live/VPS proof.');
}
