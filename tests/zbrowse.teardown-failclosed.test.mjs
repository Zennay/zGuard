// Execute production gateway teardown functions with deterministic container
// failures. This is source/handler-level proof, not a VPS/Docker probe.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { parseStrictAcceptanceArgs } from '../tools/gateway-strict-acceptance-flags.mjs';

const requireFailClosed = parseStrictAcceptanceArgs(process.argv.slice(2), '--require-fail-closed');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'zbrowse/gateway/server.js'), 'utf8');

function extract(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start,
    'real gateway teardown implementation must remain extractable');
  return source.slice(start, end);
}
const code = extract('async function stopContainer(', 'async function createSession(') +
  '\n' + extract('async function destroySession(', 'function findSession(') +
  '\n({ stopContainer, destroySession });';

async function scenario({ stopFails, removeFails }) {
  const token = 'T'.repeat(32); // synthetic, never an actual bearer
  const ip = '192.0.2.5'; // RFC 5737 documentation-only IP
  let stopCalls = 0;
  let removeCalls = 0;
  const container = {
    async stop(options) {
      stopCalls++;
      assert.equal(options.t, 3, 'real gateway must keep bounded stop timeout');
      if (stopFails) throw new Error('fixture stop failure');
    },
    async remove(options) {
      removeCalls++;
      assert.equal(options.force, true, 'fallback removal must be forced');
      if (removeFails) throw new Error('fixture remove failure');
    }
  };
  const sessions = new Map([[token, { token, ip, container }]]);
  const sessionsByIp = new Map([[ip, token]]);
  const { destroySession } = vm.runInNewContext(code, {
    sessions, sessionsByIp
  }, { filename: 'zbrowse/gateway/server.js', timeout: 1000 });
  assert.equal(typeof destroySession, 'function');
  let reportedFailure = false;
  try {
    await destroySession(token);
  } catch {
    reportedFailure = true;
  }
  return {
    stopCalls, removeCalls, reportedFailure,
    sessionTracked: sessions.has(token),
    ownerTracked: sessionsByIp.get(ip) === token,
    capacityUsed: sessions.size
  };
}

const stopped = await scenario({ stopFails: false, removeFails: false });
assert.equal(stopped.stopCalls, 1, 'normal shutdown must stop the container');
assert.equal(stopped.removeCalls, 0, 'normal shutdown must not force-remove');
assert.equal(stopped.reportedFailure, false, 'successful shutdown should complete');
assert.equal(stopped.sessionTracked, false, 'stopped container must free session registry');
assert.equal(stopped.ownerTracked, false, 'stopped container must free IP reservation');
assert.equal(stopped.capacityUsed, 0, 'successful shutdown frees admission capacity');

const removed = await scenario({ stopFails: true, removeFails: false });
assert.equal(removed.stopCalls, 1, 'stop failure must try graceful stop');
assert.equal(removed.removeCalls, 1, 'stop failure must attempt force removal');
assert.equal(removed.reportedFailure, false, 'successful fallback removal should complete');
assert.equal(removed.sessionTracked, false, 'removed container must free session registry');
assert.equal(removed.ownerTracked, false, 'removed container must free IP reservation');

const orphan = await scenario({ stopFails: true, removeFails: true });
assert.equal(orphan.stopCalls, 1, 'failed teardown must attempt graceful stop');
assert.equal(orphan.removeCalls, 1, 'failed teardown must attempt forced removal');

if (requireFailClosed) {
  assert.deepEqual({
    failureSurfaced: orphan.reportedFailure,
    capacityReserved: orphan.sessionTracked && orphan.capacityUsed === 1,
    ownershipRetained: orphan.ownerTracked
  }, {
    failureSurfaced: true,
    capacityReserved: true,
    ownershipRetained: true
  }, 'gateway silently loses failed-to-remove browser container from tracking and capacity (issue #7)');
  console.log('Gateway teardown failure remains surfaced and capacity-reserved');
} else {
  console.log('Gateway stop success and force-remove fallback validated; ' +
    'strict failed-stop+failed-remove accounting requires --require-fail-closed. ' +
    'Observed failureSurfaced=' + orphan.reportedFailure +
    ', capacityReserved=' + orphan.sessionTracked +
    ', ownershipRetained=' + orphan.ownerTracked);
}
