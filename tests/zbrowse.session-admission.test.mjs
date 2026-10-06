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

console.log('zBrowse session admission tests passed');
