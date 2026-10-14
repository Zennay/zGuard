// Execute the shipped createSession() and stopContainer() with synthetic Docker
// lifecycle failures. This is source-bound QA, never a real VPS/Docker action.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { createSessionAdmission } from '../zbrowse/gateway/session-admission.js';
import { parseStrictAcceptanceArgs } from '../tools/gateway-strict-acceptance-flags.mjs';

const strict = parseStrictAcceptanceArgs(process.argv.slice(2), '--require-failed-start-fail-closed');
const source = fs.readFileSync(new URL('../zbrowse/gateway/server.js', import.meta.url), 'utf8');
const start = source.indexOf('async function stopContainer(');
const end = source.indexOf('async function destroySession(', start);
assert.ok(start >= 0 && end > start && source.slice(start, end).includes('async function createSession('),
  'shipped container stop and browser startup source must remain extractable');
const code = source.slice(start, end) + '\ncreateSession';

async function scenario({ stopFails, removeFails, startFails = false }) {
  const sessions = new Map();
  const sessionsByIp = new Map();
  const admission = createSessionAdmission(1);
  const live = new Set();
  let created = 0;
  let stops = 0;
  let removals = 0;
  let failedContainerName;
  const docker = {
    async createContainer(options) {
      created++;
      const n = created;
      // A failed Docker start still leaves a *created* container that
      // consumes daemon resources until forced removal succeeds.
      live.add(n);
      assert.equal(options.HostConfig.AutoRemove, true,
        'real browser containers must preserve auto-removal');
      assert.equal(options.HostConfig.NetworkMode, 'fixture-network');
      assert.deepEqual(Array.from(options.HostConfig.SecurityOpt),
        ['no-new-privileges:true']);
      if (n === 1) failedContainerName = options.name;
      return {
        async start() {
          if (n === 1 && startFails)
            throw new Error('synthetic Docker container.start failure');
        },
        async stop(options) {
          stops++;
          assert.equal(options.t, 3, 'browser graceful stop must remain bounded');
          if (n === 1 && stopFails) throw new Error('synthetic Docker stop failure');
          live.delete(n);
        },
        async remove(options) {
          removals++;
          assert.equal(options.force, true, 'fallback remove must be forced');
          if (n === 1 && removeFails) throw new Error('synthetic Docker force remove failure');
          live.delete(n);
        }
      };
    }
  };
  const context = {
    crypto, docker, sessions, sessionsByIp, Date,
    config: {
      image: 'fixture-browser', network: 'fixture-network',
      ttlMs: 900_000, memoryBytes: 100_000_000, nanoCpus: 1e9
    },
    async waitForBrowser(containerName) {
      if (containerName === failedContainerName)
        throw new Error('synthetic browser readiness failure');
    }
  };
  const createSession = vm.runInNewContext(code, context, {
    filename: 'zbrowse/gateway/server.js', timeout: 1000
  });
  const firstIp = '192.0.2.11';
  assert.deepEqual(admission.tryReserve(firstIp, sessions.size),
    { ok: true }, 'first browser should fit MAX_SESSIONS=1');
  let firstError;
  try {
    await createSession(firstIp, 'https://fawesome.tv/');
  } catch (error) {
    firstError = error;
  } finally {
    admission.release(firstIp);
  }
  assert.ok(firstError, 'synthetic readiness failure must not be swallowed');
  assert.equal(created, 1);
  assert.equal(stops, 1, 'failed startup must try stopping its unpublished container');
  assert.equal(removals, stopFails ? 1 : 0,
    'force-removal should only be needed if graceful stop fails');
  const firstOrphan = live.has(1);
  const trackedAfterFailure = sessions.size;
  const secondIp = '192.0.2.12';
  const secondAdmission = admission.tryReserve(secondIp, sessions.size);
  if (secondAdmission.ok) {
    try {
      const session = await createSession(secondIp, 'https://fawesome.tv/');
      assert.equal(sessionsByIp.get(secondIp), session.token,
        'second browser must be registered with its owner');
    } finally {
      admission.release(secondIp);
    }
  }
  return {
    firstOrphan, secondAdmitted: secondAdmission.ok,
    physicalBrowsers: live.size, trackedAfterFailure,
    registeredBrowsers: sessions.size,
    firstErrorIncludesCleanup: /stop|remov|cleanup|teardown/i.test(firstError.message)
  };
}

const recovered = await scenario({ stopFails: true, removeFails: false });
assert.deepEqual({
  firstOrphan: recovered.firstOrphan,
  secondAdmitted: recovered.secondAdmitted,
  physicalBrowsers: recovered.physicalBrowsers,
  registeredBrowsers: recovered.registeredBrowsers
}, {
  firstOrphan: false, secondAdmitted: true,
  physicalBrowsers: 1, registeredBrowsers: 1
}, 'successful force-remove must free the browser slot for legitimate reuse');

const unremoved = await scenario({ stopFails: true, removeFails: true });

// A throw from Docker container.start() is a separate failure boundary from
// waitForBrowser() readiness timing out. Even when the container never
// entered running state, Docker already allocated an object to reconcile.
const rejectedStartRecovered = await scenario({
  startFails: true, stopFails: true, removeFails: false
});
assert.deepEqual({
  firstOrphan: rejectedStartRecovered.firstOrphan,
  secondAdmitted: rejectedStartRecovered.secondAdmitted,
  physicalBrowsers: rejectedStartRecovered.physicalBrowsers,
  registeredBrowsers: rejectedStartRecovered.registeredBrowsers
}, {
  firstOrphan: false, secondAdmitted: true,
  physicalBrowsers: 1, registeredBrowsers: 1
}, 'failed Docker start must force-remove a created container before legitimate retry');

const rejectedStartOrphan = await scenario({
  startFails: true, stopFails: true, removeFails: true
});
assert.equal(rejectedStartOrphan.firstOrphan, true,
  'failed container.start plus failed force-removal must retain the orphan fixture');
assert.equal(rejectedStartOrphan.trackedAfterFailure, 0,
  'an unpublished failed start must never fabricate a tracked active session');

function failClosedScenario(result) {
  return !result.firstOrphan ||
    (!result.secondAdmitted && result.firstErrorIncludesCleanup);
}
const failClosed = [unremoved, rejectedStartOrphan].every(failClosedScenario);
if (strict) {
  assert.equal(failClosed, true,
    'failed readiness or Docker start plus failed stop/remove must not silently admit a second browser (issue #7)');
  console.log('Shipped gateway startup failure cleanup preserves capacity and surfaces errors');
} else {
  console.log('Shipped failed startup teardown, both readiness timeout and Docker start throw: ' +
    'orphanAdmitted=' + unremoved.secondAdmitted +
    ', failedStartOrphanAdmitted=' + rejectedStartOrphan.secondAdmitted +
    ', strictOrphanFailuresProtected=' + failClosed +
    ' (strict --require-failed-start-fail-closed remains outstanding; issue #7)');
}
