import assert from 'node:assert/strict';
import { createSessionAdmission } from '../zbrowse/gateway/session-admission.js';

const gate = createSessionAdmission(1);
assert.deepEqual(gate.tryReserve('198.51.100.1', 0), { ok: true });
assert.equal(gate.pendingCount, 1);
assert.deepEqual(
  gate.tryReserve('198.51.100.2', 0),
  { ok: false, reason: 'capacity' },
  'a pending browser start must consume capacity'
);
assert.deepEqual(
  gate.tryReserve('198.51.100.1', 0),
  { ok: false, reason: 'pending' },
  'the same client must not start two containers concurrently'
);
gate.release('198.51.100.1');
assert.equal(gate.pendingCount, 0);
assert.deepEqual(gate.tryReserve('198.51.100.2', 0), { ok: true });
gate.release('198.51.100.2');

const larger = createSessionAdmission(2);
assert.deepEqual(larger.tryReserve('a', 1), { ok: true });
assert.deepEqual(larger.tryReserve('b', 1), { ok: false, reason: 'capacity' });
larger.release('a');

// Exercise the admission boundary across capacities and already-active sessions.
// Pending starts are synchronous reservations: even a burst of callers must
// never admit more than MAX_SESSIONS - activeSessions browser starts.
for (let maxSessions = 1; maxSessions <= 8; maxSessions += 1) {
  for (let activeSessions = 0; activeSessions <= maxSessions; activeSessions += 1) {
    const admission = createSessionAdmission(maxSessions);
    const available = maxSessions - activeSessions;
    const reservedIps = [];

    for (let index = 0; index < maxSessions * 2 + 2; index += 1) {
      const ip = `client-${index}`;
      const decision = admission.tryReserve(ip, activeSessions);
      if (index < available) {
        assert.deepEqual(
          decision,
          { ok: true },
          `capacity ${maxSessions}, active ${activeSessions}: should admit slot ${index}`
        );
        reservedIps.push(ip);
      } else {
        assert.deepEqual(
          decision,
          { ok: false, reason: 'capacity' },
          `capacity ${maxSessions}, active ${activeSessions}: excess starts must fail closed`
        );
      }
      assert.equal(
        admission.pendingCount,
        Math.min(index + 1, available),
        'rejected starts must not reserve capacity'
      );
    }

    for (const ip of reservedIps) {
      assert.deepEqual(
        admission.tryReserve(ip, activeSessions),
        { ok: false, reason: 'pending' },
        'repeat request from a pending IP must never create another reservation'
      );
    }
    assert.equal(admission.pendingCount, available);

    // Teardown retries must be harmless; releasing pending slots makes room
    // again without touching any already-active browser count.
    admission.release('never-reserved');
    assert.equal(admission.pendingCount, available);
    for (const ip of reservedIps) {
      admission.release(ip);
      admission.release(ip);
    }
    assert.equal(admission.pendingCount, 0, 'cleanup must fully release pending capacity');

    const afterCleanup = admission.tryReserve('replacement', activeSessions);
    assert.deepEqual(
      afterCleanup,
      available > 0 ? { ok: true } : { ok: false, reason: 'capacity' },
      'new admission after cleanup must respect remaining active capacity'
    );
    admission.release('replacement');
    assert.equal(admission.pendingCount, 0);
  }
}

console.log('zBrowse session admission tests passed');
