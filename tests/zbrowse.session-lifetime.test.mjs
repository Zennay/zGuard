import assert from 'node:assert/strict';
import { isSessionExpired } from '../zbrowse/gateway/session-lifetime.js';

const session = {
  expiresAt: 10_000,
  lastSeenAt: 4_000
};

assert.equal(isSessionExpired(session, 5_000, 8_999), false);
assert.equal(isSessionExpired(session, 5_000, 9_000), true, 'idle boundary must expire exactly');
assert.equal(isSessionExpired(session, 20_000, 9_999), false);
assert.equal(isSessionExpired(session, 20_000, 10_000), true, 'hard TTL boundary must expire exactly');

// The first deadline (idle timeout or hard TTL) must win, including exact
// millisecond boundaries. Model this as a deadline invariant over realistic
// short and long sessions rather than relying on only two sample timestamps.
const baseTime = 1_800_000_000_000;
let checked = 0;
for (const ttlMs of [1, 1000, 30_000, 15 * 60_000, 60 * 60_000]) {
  for (const idleMs of [1, 1000, 5 * 60_000, 20 * 60_000]) {
    for (const activityOffset of [0, Math.floor(ttlMs / 2), ttlMs - 1]) {
      const lastSeenAt = baseTime + activityOffset;
      const expiresAt = baseTime + ttlMs;
      const actualDeadline = Math.min(expiresAt, lastSeenAt + idleMs);
      const candidate = { expiresAt, lastSeenAt };

      for (const [at, expected] of [
        [baseTime - 1, false],
        [actualDeadline - 1, false],
        [actualDeadline, true],
        [actualDeadline + 1, true],
        [expiresAt + idleMs + 1, true]
      ]) {
        assert.equal(
          isSessionExpired(candidate, idleMs, at),
          expected,
          `TTL=${ttlMs}, idle=${idleMs}, activity=${activityOffset}: first deadline must win at ${at}`
        );
        checked += 1;
      }
    }
  }
}

// Heartbeats may extend idle activity only up to the immutable hard TTL.
const heartbeatSession = { expiresAt: baseTime + 60_000, lastSeenAt: baseTime };
assert.equal(isSessionExpired(heartbeatSession, 5_000, baseTime + 4_999), false);
heartbeatSession.lastSeenAt = baseTime + 4_999;
assert.equal(isSessionExpired(heartbeatSession, 5_000, baseTime + 9_998), false);
assert.equal(isSessionExpired(heartbeatSession, 5_000, baseTime + 9_999), true);
heartbeatSession.lastSeenAt = baseTime + 59_999;
assert.equal(
  isSessionExpired(heartbeatSession, 5_000, baseTime + 60_000),
  true,
  'a heartbeat must never extend the absolute session expiration deadline'
);

console.log(`zBrowse session expiry boundary matrix passed ${checked} cases`);

console.log('zBrowse session lifetime tests passed');
