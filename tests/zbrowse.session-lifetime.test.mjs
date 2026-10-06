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

console.log('zBrowse session lifetime tests passed');
