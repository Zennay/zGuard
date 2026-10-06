import assert from 'node:assert/strict';
import { liveSessionCount } from '../zbrowse/gateway/session-capacity.js';
import { createSessionAdmission } from '../zbrowse/gateway/session-admission.js';

const now = 20_000;
const idleMs = 5_000;
const sessions = new Map([
  ['idle-expired', { token: 'idle-expired', expiresAt: 30_000, lastSeenAt: 15_000 }],
  ['ttl-expired', { token: 'ttl-expired', expiresAt: 20_000, lastSeenAt: 19_999 }],
  ['live', { token: 'live', expiresAt: 30_000, lastSeenAt: 19_999 }]
]);

assert.equal(
  liveSessionCount(sessions, idleMs, now),
  1,
  'expired sessions must not consume admission capacity'
);

const oneSlot = createSessionAdmission(1);
assert.deepEqual(
  oneSlot.tryReserve('198.51.100.10', liveSessionCount(new Map([
    ['expired-foreign-session', { token: 'expired-foreign-session', expiresAt: 19_999, lastSeenAt: 19_999 }]
  ]), idleMs, now)),
  { ok: true },
  'a foreign session past hard TTL must not cause a false capacity rejection'
);
oneSlot.release('198.51.100.10');

assert.equal(
  liveSessionCount(new Map([
    ['boundary-live', { token: 'boundary-live', expiresAt: 30_000, lastSeenAt: 15_001 }]
  ]), idleMs, now),
  1,
  'a session one millisecond before idle expiry remains live'
);

console.log('zBrowse session capacity tests passed');
