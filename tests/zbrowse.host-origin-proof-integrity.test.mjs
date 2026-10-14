// Issue #457: do not permit a baseline Host/Origin log to impersonate
// strict remediation evidence. This offline contract never probes the public
// TV, VPS, reverse proxy or Docker. The existing loopback source test remains
// the authoritative HTTP behavior check when explicitly dispatched strict.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const testSource = fs.readFileSync(
  new URL('./zbrowse.host-origin-isolation-real-http.test.mjs', import.meta.url), 'utf8'
);
const workflow = fs.readFileSync(
  new URL('../.github/workflows/zbrowse-trusted-host-origin-qa.yml', import.meta.url), 'utf8'
);

function verify(source, yaml) {
  const denying = source.match(/function denied\(outcome\) \{([\s\S]*?)\n  \}/);
  assert.ok(denying, 'negative Host result must have a real denial predicate');
  for (const value of [
    'outcome.status >= 400', 'outcome.starts === 0',
    'outcome.reserves === 0', '!outcome.bearer'
  ]) {
    assert.ok(denying[1].includes(value),
      'strict denial must check failure status, no browser, no reservation and no bearer: ' + value);
  }
  // Raw duplicate Hosts must travel over actual HTTP, not a mocked express
  // invocation that silently coalesces the second header.
  assert.ok(source.includes('http.request({') &&
    source.includes("host.flatMap(value => ['Host', value])"),
    'negative Host proof must send raw HTTP with duplicate Host lines');
  const start = source.lastIndexOf('  if (strict) {');
  const end = source.indexOf('  } else {', start);
  assert.ok(start > 0 && end > start, 'strict Host proof must be an opt-in failing branch');
  const strictBlock = source.slice(start, end);
  for (const needle of [
    'assert.ok(denied(changedHost)', 'assert.ok(denied(reusedHost)',
    'assert.ok(denied(tvViaForeignHost)',
    'assert.ok(denied(tvReusedViaForeignHost)',
    'assert.ok(denied(metadataFreeHost) && denied(metadataFreeReuse)',
    'assert.ok(duplicateHostOutcomes.every(denied) && duplicateHostReuses.every(denied)',
    'assert.ok([alternatePort, alternatePortReuse, emptyHost, emptyHostReuse].every(denied)',
    'assert.ok(denied(outcome)'
  ]) {
    assert.ok(strictBlock.includes(needle),
      'strict Host proof must reject this admission/reuse vector: ' + needle);
  }
  // The baseline must remain non-strict to report current exposure honestly,
  // and strict dispatch must invoke the matching actual test executable.
  assert.ok(yaml.includes('node tests/zbrowse.host-origin-isolation-real-http.test.mjs\n' +
    '          if [ "$REQUIRE_CANONICAL_HOST" = "true" ]; then\n' +
    '            node tests/zbrowse.host-origin-isolation-real-http.test.mjs --require-canonical-host\n' +
    '          fi'), 'manual strict Host gate must run real HTTP test with strict argument');
}
verify(testSource, workflow);

let mutations = 0;
for (const [label, needle, replacement] of [
  ['token-bearing response accepted', '!outcome.bearer', 'true'],
  ['browser starts omitted', 'outcome.starts === 0', 'true'],
  ['reservation leaks omitted', 'outcome.reserves === 0', 'true'],
  ['existing bearer reuse untested', 'assert.ok(denied(reusedHost)',
    'console.log(denied(reusedHost)'],
  ['proxy spoofed Host accepted', 'assert.ok(denied(outcome)',
    'console.log(denied(outcome)'],
  ['duplicated wire Host silently removed',
    "host.flatMap(value => ['Host', value])",
    "host.map(value => value)"]
]) {
  assert.ok(testSource.includes(needle), label + ': mutation target missing');
  const changed = testSource.replace(needle, replacement);
  assert.notEqual(changed, testSource, label + ': mutation must modify fixture');
  assert.throws(() => verify(changed, workflow),
    undefined, label + ': weakened real HTTP proof must not pass review');
  mutations++;
}
const omittedStrict = workflow.replace(
  'node tests/zbrowse.host-origin-isolation-real-http.test.mjs --require-canonical-host',
  'node tests/zbrowse.host-origin-isolation-real-http.test.mjs');
assert.notEqual(omittedStrict, workflow, 'strict workflow mutation target required');
assert.throws(() => verify(testSource, omittedStrict),
  undefined, 'strict Host dispatch must not be replaced by baseline logging');
console.log('Host/Origin strict evidence integrity PASS: ' + (mutations + 1) +
  ' negative mutations; production ingress remains unverified');
