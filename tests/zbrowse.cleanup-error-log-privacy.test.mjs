// Source-bound gateway cleanup timer acceptance. All sessions, Docker
// teardown errors and credentials are synthetic. No real timers, VPS or
// external side effects; logs are captured in memory, never printed verbatim.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { format } from 'node:util';
import { parseStrictAcceptanceArgs } from '../tools/gateway-strict-acceptance-flags.mjs';

const strict = parseStrictAcceptanceArgs(process.argv.slice(2), '--require-redacted-cleanup-errors');
const source = fs.readFileSync(new URL('../zbrowse/gateway/server.js', import.meta.url), 'utf8');
const start = source.indexOf('const cleanupTimer = setInterval(() => {');
const stop = source.indexOf('async function shutdown() {', start);
assert.ok(start >= 0 && stop > start,
  'actual shipped cleanup timer and its failure logging must remain extractable');
const code = source.slice(start, stop);
assert.ok(code.includes('console.error("Cleanup failed", error)'),
  'timer fixture must execute source-level failure diagnostics');

const orphanToken = 'C'.repeat(32);
const successfulToken = 'D'.repeat(32);
const healthyToken = 'H'.repeat(32);
const password = 'fake-browser-config-password';
const sessions = new Map([
  [orphanToken, { token: orphanToken, expired: true }],
  [successfulToken, { token: successfulToken, expired: true }],
  [healthyToken, { token: healthyToken, expired: false }]
]);
const destroys = [];
const logs = [];
let tick = null;
let intervalMs = 0;
let timerUnref = 0;
const sandbox = {
  sessions, config: { idleMs: 300_000 },
  Date,
  setInterval(callback, millis) {
    assert.equal(tick, null, 'gateway must register one cleanup callback');
    tick = callback;
    intervalMs = millis;
    return { unref() { timerUnref++; } };
  },
  isSessionExpired(session) { return session.expired; },
  async destroySession(token) {
    destroys.push(token);
    if (token === orphanToken) {
      // A synthetic Docker error includes request-specific container label
      // and password. This tests the conditional risk from printing raw
      // exception objects, not observed production Docker error content.
      throw new Error('remove failed label zbrowse.token=' + token +
        ' Env PASSWORD=' + password);
    }
    sessions.delete(token);
  },
  console: { error(...args) { logs.push(format(...args)); } }
};
vm.runInNewContext(code, sandbox, {
  filename: 'zbrowse/gateway/server.js', timeout: 1000
});
assert.equal(typeof tick, 'function',
  'shipped cleanup timer must be installed');
assert.equal(intervalMs, 30_000, 'cleanup interval must stay bounded');
assert.equal(timerUnref, 1,
  'cleanup timer must not keep the gateway process alive on its own');

// Execute the real timer callback but not wall-clock scheduling.
tick();
// The real code attaches .catch to async destroySession; drain its microtask
// without starting an external timer or background job.
await Promise.resolve();
await Promise.resolve();

assert.deepEqual(destroys.sort(), [orphanToken, successfulToken].sort(),
  'cleanup must target both expired sessions but never the healthy one');
assert.equal(sessions.has(successfulToken), false,
  'successful cleanup must clear its synthetic session');
assert.equal(sessions.has(orphanToken), true,
  'failed teardown fixture must retain the synthetic orphan');
assert.equal(sessions.has(healthyToken), true,
  'unexpired session must never be removed');
assert.equal(logs.length, 1,
  'exactly one failing container cleanup must emit one diagnostic');
assert.ok(logs[0].includes('Cleanup failed'),
  'safe, actionable diagnostic label must be retained');

// Never surface the captured unredacted text to CI/user-facing output.
// Require the runtime to log a bounded sanitized error code or category,
// rather than forwarding raw Docker error data and its stack trace.
const leaked = logs.filter(line =>
  line.includes(orphanToken) || line.includes(password));
if (strict) {
  assert.equal(leaked.length, 0,
    'periodic cleanup logs must not expose bearer labels or Docker environment credentials');
}
console.log('Shipped periodic browser cleanup log probe: ' +
  destroys.length + ' expired browser removals, ' +
  logs.length + ' synthetic failures, privacy-safe logs=' +
  (logs.length - leaked.length) + '/' + logs.length +
  '; strict remediation proof: --require-redacted-cleanup-errors');
