// Prove the shipped shutdown does not report success if browser container
// teardown rejected. Executes extracted shutdown() with inert timers, server
// and process doubles; never sends a signal or exits a real worker/VPS.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseStrictAcceptanceArgs } from '../tools/gateway-strict-acceptance-flags.mjs';

const strict = parseStrictAcceptanceArgs(process.argv.slice(2), '--require-shutdown-fail-closed');
const source = fs.readFileSync(new URL('../zbrowse/gateway/server.js', import.meta.url), 'utf8');
const start = source.indexOf('async function shutdown() {');
const end = source.indexOf('process.on("SIGTERM"', start);
assert.ok(start >= 0 && end > start,
  'real gateway shutdown must remain extractable from the source');
const code = source.slice(start, end) + '\nshutdown()';

async function scenario({ failTokens = [], tokens = ['synthetic-a', 'synthetic-b'] } = {}) {
  const sessions = new Map(tokens.map(token => [token, { token }]));
  const removed = [];
  const failures = new Set(failTokens);
  const exitCodes = [];
  let clears = 0;
  let closeCalls = 0;
  let safetyTimers = 0;
  const context = {
    cleanupTimer: {},
    sessions,
    clearInterval() { clears++; },
    setTimeout(_callback, ms) {
      assert.equal(ms, 8000, 'shutdown must preserve bounded cleanup safety timeout');
      safetyTimers++;
      return { unref() {} };
    },
    async destroySession(token) {
      removed.push(token);
      if (failures.has(token)) throw new Error('synthetic teardown failure: ' + token);
      sessions.delete(token);
    },
    server: {
      close(callback) {
        closeCalls++;
        callback();
      }
    },
    process: {
      exit(code) { exitCodes.push(code); }
    }
  };
  await vm.runInNewContext(code, context, {
    filename: 'zbrowse/gateway/server.js', timeout: 1000
  });
  return {
    remaining: sessions.size,
    removed, exitCodes, clears, closeCalls, safetyTimers
  };
}

const normal = await scenario();
assert.deepEqual(normal.removed, ['synthetic-a', 'synthetic-b'],
  'shutdown must attempt every active container');
assert.deepEqual(normal.exitCodes, [0],
  'successful cleanup should retain healthy exit code');
assert.equal(normal.remaining, 0);
assert.equal(normal.clears, 1);
assert.equal(normal.closeCalls, 1);
assert.equal(normal.safetyTimers, 1);

const failed = await scenario({ failTokens: ['synthetic-b'] });
assert.deepEqual(failed.removed, ['synthetic-a', 'synthetic-b'],
  'teardown failure must not prevent cleanup of remaining containers');
assert.equal(failed.remaining, 1,
  'failed cleanup fixture must preserve the synthetic orphan');
assert.equal(failed.closeCalls, 1, 'shutdown must attempt the gateway listener close');

// The supervisor must be warned even when *every* Docker teardown fails,
// not only when a single session out of two is left behind. Neither failed
// container may be silently counted as removed. A third unrelated session
// proves Promise.allSettled must still attempt the healthy teardown.
const everyFailed = await scenario({
  tokens: ['synthetic-a', 'synthetic-b'],
  failTokens: ['synthetic-a', 'synthetic-b']
});
assert.deepEqual(everyFailed.removed, ['synthetic-a', 'synthetic-b'],
  'shutdown must attempt all containers even when the first stop fails');
assert.equal(everyFailed.remaining, 2, 'two failed removals must retain two orphans');
assert.equal(everyFailed.closeCalls, 1, 'failed shutdown must still close HTTP listener');
assert.equal(everyFailed.safetyTimers, 1, 'failed shutdown must retain bounded forced exit timer');

const mixed = await scenario({
  tokens: ['synthetic-a', 'synthetic-b', 'synthetic-c'],
  failTokens: ['synthetic-a', 'synthetic-c']
});
assert.deepEqual(mixed.removed, ['synthetic-a', 'synthetic-b', 'synthetic-c'],
  'mixed failures must never short-circuit independent container cleanup');
assert.equal(mixed.remaining, 2, 'only successfully stopped container may leave state');

const badExit = result => result.exitCodes.length === 1 && result.exitCodes[0] !== 0;
const failClosed = [failed, everyFailed, mixed].every(badExit);
if (strict) {
  assert.equal(failClosed, true,
    'shipped shutdown acknowledged one or multiple failed browser removals as successful exit 0 (issue #7)');
  console.log('Gateway shutdown fails closed when browser teardown is rejected');
} else {
  console.log('Shipped shutdown source exercised with partial/full/mixed container failures; ' +
    'nonzero exit for every orphan scenario=' + failClosed +
    ', tested failed removal cases=3' +
    '. Strict proof requires --require-shutdown-fail-closed (issue #7)');
}
