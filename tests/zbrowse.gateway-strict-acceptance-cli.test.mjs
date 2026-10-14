// Verify shipped gateway strict acceptance CLIs reject bad options
// before source parsing. This intentionally never runs known-red strict gates.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseStrictAcceptanceArgs } from '../tools/gateway-strict-acceptance-flags.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cases = [
  {
    filename: 'zbrowse.start-url-allowlist.test.mjs',
    flag: '--require-credential-free',
    workflow: 'zbrowse-start-url-allowlist-validation.yml',
    input: 'require_credential_free',
    env: 'REQUIRE_CREDENTIAL_FREE'
  },
  {
    filename: 'zbrowse.host-origin-isolation-real-http.test.mjs',
    flag: '--require-canonical-host',
    workflow: 'zbrowse-trusted-host-origin-qa.yml',
    input: 'require_canonical_host',
    env: 'REQUIRE_CANONICAL_HOST'
  },
  {
    filename: 'zbrowse.websocket-upgrade-auth-real-tcp.test.mjs',
    flag: '--require-websocket-host',
    workflow: 'zbrowse-viewer-cache-privacy.yml',
    input: 'require_websocket_host',
    env: 'REQUIRE_WEBSOCKET_HOST'
  },
  {
    filename: 'zbrowse.websocket-upgrade-auth-real-tcp.test.mjs',
    flag: '--require-websocket-origin',
    workflow: 'zbrowse-viewer-cache-privacy.yml',
    input: 'require_websocket_origin',
    env: 'REQUIRE_WEBSOCKET_ORIGIN'
  },
  {
    filename: 'zbrowse.teardown-failclosed.test.mjs',
    flag: '--require-fail-closed',
    workflow: 'zbrowse-teardown-failclosed.yml',
    input: 'require_fail_closed',
    env: 'REQUIRE_FAIL_CLOSED'
  },
  {
    filename: 'zbrowse.cross-origin-simple-post-real-http.test.mjs',
    flag: '--require-json-only',
    workflow: 'zbrowse-start-url-allowlist-validation.yml',
    input: 'require_json_only',
    env: 'REQUIRE_JSON_ONLY'
  },
  {
    filename: 'zbrowse.session-start-log-privacy-real-http.test.mjs',
    flag: '--require-redacted-start-errors',
    workflow: 'zbrowse-session-start-log-privacy.yml',
    input: 'require_redacted_start_errors',
    env: 'REQUIRE_REDACTED_START_ERRORS'
  },
  {
    filename: 'zbrowse.proxy-error-log-privacy-real-http.test.mjs',
    flag: '--require-redacted-proxy-errors',
    workflow: 'zbrowse-viewer-proxy-log-privacy.yml',
    input: 'require_redacted_proxy_errors',
    env: 'REQUIRE_REDACTED_PROXY_ERRORS'
  },
  {
    filename: 'zbrowse.cleanup-error-log-privacy.test.mjs',
    flag: '--require-redacted-cleanup-errors',
    workflow: 'zbrowse-cleanup-error-log-privacy.yml',
    input: 'require_redacted_cleanup_errors',
    env: 'REQUIRE_REDACTED_CLEANUP_ERRORS'
  },
  {
    filename: 'zbrowse.websocket-proxy-error-log-privacy-real-tcp.test.mjs',
    flag: '--require-redacted-ws-proxy-errors',
    workflow: 'zbrowse-websocket-proxy-error-log-privacy.yml',
    input: 'require_redacted_ws_proxy_errors',
    env: 'REQUIRE_REDACTED_WS_PROXY_ERRORS'
  },
  {
    filename: 'zbrowse.rate-limit-identity-parity.test.mjs',
    flag: '--require-key-parity',
    workflow: 'zbrowse-rate-limit-identity.yml',
    input: 'require_key_parity',
    env: 'REQUIRE_KEY_PARITY'
  }
];
assert.throws(() => parseStrictAcceptanceArgs('bad', '--require-fail-closed'), TypeError);
assert.throws(() => parseStrictAcceptanceArgs([], 'not-a-flag'), TypeError);

for (const { filename, flag, workflow, input, env } of cases) {
  assert.equal(parseStrictAcceptanceArgs([], flag), false, 'baseline is not strict evidence');
  assert.equal(parseStrictAcceptanceArgs([flag], flag), true, 'exact opt-in must be enabled');
  const invalid = [
    [flag, flag],
    [flag, '--unknown'],
    ['--unknown', flag],
    ['--not-' + flag.slice(2)],
    [flag + '=true'],
    [''],
    ['--']
  ];
  const entry = path.join(here, filename);
  for (const args of invalid) {
    assert.throws(() => parseStrictAcceptanceArgs(args, flag), /Invalid strict acceptance arguments/,
      filename + ': malformed strict arguments must reject');
    const child = spawnSync(process.execPath, [entry, ...args], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 256 * 1024
    });
    assert.equal(child.status, 1, filename + ': invalid CLI must exit 1');
    assert.match(child.stderr, /Invalid strict acceptance arguments/,
      filename + ': real CLI must run strict parser before test setup');
    assert.doesNotMatch(child.stdout, /passed|validated|requires|Observed/,
      filename + ': invalid CLI must never display normal or strict success');
  }

  // Ensure workflow_dispatch's strict boolean remains connected to the exact
  // command (not to the standard non-strict command or a typo).
  const yaml = fs.readFileSync(path.resolve(here, '../.github/workflows', workflow), 'utf8');
  const inputStart = yaml.indexOf('      ' + input + ':');
  assert.ok(inputStart >= 0, filename + ': missing dispatch input');
  const nextInput = yaml.indexOf('\n      ', inputStart + 8);
  const inputBlock = yaml.slice(inputStart, nextInput < 0 ? undefined : nextInput);
  assert.match(inputBlock, /\btype:\s*boolean\b/,
    filename + ': strict dispatch input must be typed boolean');
  assert.match(inputBlock, /\bdefault:\s*false\b/,
    filename + ': opt-in strict remediation must default to false until green');
  // Comments or echoes must not be mistaken for a real strict command.
  const executable = yaml.split('\n').filter(line =>
    !line.trimStart().startsWith('#')).join('\n');
  assert.ok(yaml.includes(env + ': ' + '$' + '{{ inputs.' + input + " || 'false' }}"),
    filename + ': missing matching dispatch environment');
  assert.ok(executable.includes('if [ "
    '            node tests/' + filename + ' ' + flag),
    filename + ': conditional must execute exact strict test CLI');
  assert.ok(executable.includes('node tests/zbrowse.gateway-strict-acceptance-cli.test.mjs'),
    filename + ': routine hosted CI must run the negative CLI regression');
}
console.log(cases.length + ' gateway strict acceptance CLIs and workflow bindings fail closed');
 + env + '" = "true" ]; then\n' +
    '            node tests/' + filename + ' ' + flag),
    filename + ': conditional must execute exact strict test CLI');
  assert.ok(yaml.includes('node tests/zbrowse.gateway-strict-acceptance-cli.test.mjs'),
    filename + ': routine hosted CI must run the negative CLI regression');
}
console.log(cases.length + ' gateway strict acceptance CLIs and workflow bindings fail closed');
